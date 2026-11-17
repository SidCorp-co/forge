//! A person's input on a box they hold: `BoxInput` lines (`box-wire.ts` `boxInputSchema`), in
//! coordinates normalised to 0..1 of the box's view, translated for the mode. A browser box takes
//! agent-browser's `input_mouse` / `input_keyboard` socket messages, an android box scrcpy's
//! control messages, a desktop box X11 events through xdotool. Core validated and recorded each
//! line already; a line this side cannot read is dropped and said, never guessed at.

use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase", deny_unknown_fields)]
pub enum BoxInput {
    Tap { x: f64, y: f64 },
    Pointer { action: Press, x: f64, y: f64 },
    Scroll { x: f64, y: f64, dx: f64, dy: f64 },
    Key { key: String, action: KeyAction },
    Text { text: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Press {
    Down,
    Move,
    Up,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyAction {
    Down,
    Up,
    Press,
}

/// One line read, or why it is not a `BoxInput`.
pub fn parse(line: &str) -> Result<BoxInput, String> {
    let input: BoxInput = serde_json::from_str(line).map_err(|e| format!("not a BoxInput: {e}"))?;
    let unit = |v: f64| (0.0..=1.0).contains(&v);
    let ok = match &input {
        BoxInput::Tap { x, y } | BoxInput::Pointer { x, y, .. } => unit(*x) && unit(*y),
        BoxInput::Scroll { x, y, dx, dy } => {
            unit(*x) && unit(*y) && dx.abs() <= 10_000.0 && dy.abs() <= 10_000.0
        }
        BoxInput::Key { key, .. } => !key.is_empty() && key.chars().count() <= 40,
        BoxInput::Text { text } => !text.is_empty() && text.chars().count() <= 1000,
    };
    ok.then_some(input)
        .ok_or_else(|| format!("BoxInput out of its bounds: {line}"))
}

/// A unit coordinate on a side of `px` pixels.
fn px(v: f64, side: u32) -> i64 {
    (v * f64::from(side.saturating_sub(1))).round() as i64
}

// ---------- browser: agent-browser's stream socket ----------

pub fn browser(input: &BoxInput, w: u32, h: u32) -> Vec<Value> {
    let mouse = |event: &str, x: f64, y: f64, button: &str| {
        json!({ "type": "input_mouse", "eventType": event, "x": px(x, w), "y": px(y, h),
                "button": button, "clickCount": 1 })
    };
    match input {
        BoxInput::Tap { x, y } => vec![
            mouse("mouseMoved", *x, *y, "none"),
            mouse("mousePressed", *x, *y, "left"),
            mouse("mouseReleased", *x, *y, "left"),
        ],
        BoxInput::Pointer { action, x, y } => vec![match action {
            Press::Down => mouse("mousePressed", *x, *y, "left"),
            Press::Move => mouse("mouseMoved", *x, *y, "none"),
            Press::Up => mouse("mouseReleased", *x, *y, "left"),
        }],
        BoxInput::Scroll { x, y, dx, dy } => vec![json!({
            "type": "input_mouse", "eventType": "mouseWheel", "x": px(*x, w), "y": px(*y, h),
            "button": "none", "deltaX": dx, "deltaY": dy })],
        BoxInput::Key { key, action } => {
            let down = || {
                let mut m = json!({ "type": "input_keyboard", "eventType": "keyDown", "key": key });
                if let Some(text) = key_text(key) {
                    m["text"] = text.into();
                }
                m
            };
            let up = || json!({ "type": "input_keyboard", "eventType": "keyUp", "key": key });
            match action {
                KeyAction::Down => vec![down()],
                KeyAction::Up => vec![up()],
                KeyAction::Press => vec![down(), up()],
            }
        }
        BoxInput::Text { text } => text
            .chars()
            .flat_map(|c| {
                let k = c.to_string();
                [
                    json!({ "type": "input_keyboard", "eventType": "keyDown", "key": k, "text": k }),
                    json!({ "type": "input_keyboard", "eventType": "keyUp", "key": k }),
                ]
            })
            .collect(),
    }
}

/// The text a key types: itself where it is one character, a carriage return for Enter.
fn key_text(key: &str) -> Option<String> {
    match key {
        "Enter" => Some("\r".into()),
        k if k.chars().count() == 1 => Some(k.into()),
        _ => None,
    }
}

// ---------- android: scrcpy control messages ----------

/// scrcpy's generic finger, so Android reads a touch rather than a mouse.
const FINGER: i64 = -2;

fn touch(action: u8, x: f64, y: f64, w: u32, h: u32) -> Vec<u8> {
    let mut m = vec![2u8, action];
    m.extend_from_slice(&FINGER.to_be_bytes());
    m.extend_from_slice(&(px(x, w) as i32).to_be_bytes());
    m.extend_from_slice(&(px(y, h) as i32).to_be_bytes());
    m.extend_from_slice(&(w as u16).to_be_bytes());
    m.extend_from_slice(&(h as u16).to_be_bytes());
    let pressure: u16 = if action == 1 { 0 } else { 0xffff };
    m.extend_from_slice(&pressure.to_be_bytes());
    m.extend_from_slice(&0i32.to_be_bytes());
    m.extend_from_slice(&0i32.to_be_bytes());
    m
}

fn keycode(action: u8, code: i32) -> Vec<u8> {
    let mut m = vec![0u8, action];
    m.extend_from_slice(&code.to_be_bytes());
    m.extend_from_slice(&0i32.to_be_bytes());
    m.extend_from_slice(&0i32.to_be_bytes());
    m
}

fn text(t: &str) -> Vec<u8> {
    let mut m = vec![1u8];
    m.extend_from_slice(&(t.len() as u32).to_be_bytes());
    m.extend_from_slice(t.as_bytes());
    m
}

/// A scroll in pixels as scrcpy's fixed-point notches over 16 (a web wheel notch is 100 px).
fn i16fp(px: f64) -> i16 {
    let v = (px / 100.0 / 16.0).clamp(-1.0, 1.0);
    (v * 32_767.0).round() as i16
}

/// `w` x `h` is the video size the scrcpy server last reported: it drops events for another size.
pub fn android(input: &BoxInput, w: u32, h: u32) -> Vec<Vec<u8>> {
    match input {
        BoxInput::Tap { x, y } => vec![touch(0, *x, *y, w, h), touch(1, *x, *y, w, h)],
        BoxInput::Pointer { action, x, y } => {
            let a = match action {
                Press::Down => 0,
                Press::Up => 1,
                Press::Move => 2,
            };
            vec![touch(a, *x, *y, w, h)]
        }
        BoxInput::Scroll { x, y, dx, dy } => {
            let mut m = vec![3u8];
            m.extend_from_slice(&(px(*x, w) as i32).to_be_bytes());
            m.extend_from_slice(&(px(*y, h) as i32).to_be_bytes());
            m.extend_from_slice(&(w as u16).to_be_bytes());
            m.extend_from_slice(&(h as u16).to_be_bytes());
            m.extend_from_slice(&i16fp(-*dx).to_be_bytes());
            m.extend_from_slice(&i16fp(-*dy).to_be_bytes());
            m.extend_from_slice(&0i32.to_be_bytes());
            vec![m]
        }
        BoxInput::Key { key, action } => match android_keycode(key) {
            Some(code) => match action {
                KeyAction::Down => vec![keycode(0, code)],
                KeyAction::Up => vec![keycode(1, code)],
                KeyAction::Press => vec![keycode(0, code), keycode(1, code)],
            },
            None if key.chars().count() == 1 && *action != KeyAction::Up => vec![text(key)],
            None => Vec::new(),
        },
        BoxInput::Text { text: t } => vec![text(t)],
    }
}

/// Android's keycode for a web `KeyboardEvent.key`.
fn android_keycode(key: &str) -> Option<i32> {
    Some(match key {
        "Enter" => 66,
        "Backspace" => 67,
        "Tab" => 61,
        "Escape" => 111,
        "ArrowUp" => 19,
        "ArrowDown" => 20,
        "ArrowLeft" => 21,
        "ArrowRight" => 22,
        "Home" => 122,
        "End" => 123,
        "Delete" => 112,
        "PageUp" => 92,
        "PageDown" => 93,
        " " => 62,
        "GoBack" | "BrowserBack" => 4,
        "GoHome" => 3,
        "AppSwitch" => 187,
        _ => return None,
    })
}

// ---------- desktop: X11 events through xdotool ----------

/// The xdotool argv lists, run in order on the box's display.
pub fn desktop(input: &BoxInput, w: u32, h: u32) -> Vec<Vec<String>> {
    let at = |x: f64, y: f64| {
        vec![
            "mousemove".to_string(),
            px(x, w).to_string(),
            px(y, h).to_string(),
        ]
    };
    let then = |mut v: Vec<String>, rest: &[&str]| {
        v.extend(rest.iter().map(|s| s.to_string()));
        v
    };
    match input {
        BoxInput::Tap { x, y } => vec![then(at(*x, *y), &["click", "1"])],
        BoxInput::Pointer { action, x, y } => vec![match action {
            Press::Down => then(at(*x, *y), &["mousedown", "1"]),
            Press::Move => at(*x, *y),
            Press::Up => then(at(*x, *y), &["mouseup", "1"]),
        }],
        BoxInput::Scroll { x, y, dx, dy } => {
            let notches = |d: f64| ((d.abs() / 100.0).round() as usize).clamp(1, 10);
            let mut v = at(*x, *y);
            for (d, neg, pos) in [(*dy, "4", "5"), (*dx, "6", "7")] {
                if d != 0.0 {
                    v.extend(["click".into(), "--repeat".into(), notches(d).to_string()]);
                    v.push(if d < 0.0 { neg } else { pos }.into());
                }
            }
            vec![v]
        }
        BoxInput::Key { key, action } => {
            let verb = match action {
                KeyAction::Down => "keydown",
                KeyAction::Up => "keyup",
                KeyAction::Press => "key",
            };
            vec![vec![verb.into(), "--".into(), x_keysym(key)]]
        }
        BoxInput::Text { text } => vec![vec!["type".into(), "--".into(), text.clone()]],
    }
}

/// X's keysym for a web `KeyboardEvent.key`.
fn x_keysym(key: &str) -> String {
    match key {
        "Enter" => "Return",
        "Backspace" => "BackSpace",
        "Escape" => "Escape",
        "ArrowUp" => "Up",
        "ArrowDown" => "Down",
        "ArrowLeft" => "Left",
        "ArrowRight" => "Right",
        "PageUp" => "Prior",
        "PageDown" => "Next",
        " " => "space",
        "Control" => "Control_L",
        "Shift" => "Shift_L",
        "Alt" => "Alt_L",
        "Meta" => "Super_L",
        other => other,
    }
    .to_string()
}

#[cfg(test)]
mod tests;
