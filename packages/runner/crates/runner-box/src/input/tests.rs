//! A person's input reaches each mode in that mode's own words, at the pixel the page meant.

use super::*;

#[test]
fn a_tap_is_a_click_at_the_pixel_the_page_meant_in_every_mode() {
    let tap = parse(r#"{"t":"tap","x":0.5,"y":0.25}"#).unwrap();
    let b = browser(&tap, 401, 801);
    assert_eq!(b.len(), 3);
    assert_eq!(b[1]["eventType"], "mousePressed");
    assert_eq!(
        (b[1]["x"].as_i64(), b[1]["y"].as_i64()),
        (Some(200), Some(200))
    );
    assert_eq!(b[2]["eventType"], "mouseReleased");

    let a = android(&tap, 1081, 2401);
    assert_eq!(a.len(), 2, "down then up");
    let down = &a[0];
    assert_eq!(down.len(), 32, "an inject-touch message is 32 bytes");
    assert_eq!(&down[..2], &[2, 0]);
    assert_eq!(&down[2..10], &(-2i64).to_be_bytes(), "a generic finger");
    assert_eq!(i32::from_be_bytes(down[10..14].try_into().unwrap()), 540);
    assert_eq!(i32::from_be_bytes(down[14..18].try_into().unwrap()), 600);
    assert_eq!(u16::from_be_bytes(down[18..20].try_into().unwrap()), 1081);
    assert_eq!(u16::from_be_bytes(down[20..22].try_into().unwrap()), 2401);
    assert_eq!(a[1][1], 1, "the second is the release");

    let d = desktop(&tap, 1281, 801);
    assert_eq!(d, vec![vec!["mousemove", "640", "200", "click", "1"]]);
}

#[test]
fn keys_and_text_reach_each_mode() {
    let enter = parse(r#"{"t":"key","key":"Enter","action":"press"}"#).unwrap();
    let b = browser(&enter, 10, 10);
    assert_eq!(b[0]["text"], "\r");
    assert_eq!(b[1]["eventType"], "keyUp");
    let a = android(&enter, 10, 10);
    assert_eq!(a, vec![keycode(0, 66), keycode(1, 66)]);
    assert_eq!(desktop(&enter, 10, 10), vec![vec!["key", "--", "Return"]]);

    let typed = parse(r#"{"t":"text","text":"hé"}"#).unwrap();
    assert_eq!(browser(&typed, 10, 10).len(), 4);
    let a = android(&typed, 10, 10);
    assert_eq!(a[0][0], 1);
    assert_eq!(
        u32::from_be_bytes(a[0][1..5].try_into().unwrap()),
        3,
        "utf-8 bytes"
    );
    assert_eq!(desktop(&typed, 10, 10), vec![vec!["type", "--", "hé"]]);
}

#[test]
fn a_scroll_down_is_a_negative_android_notch_and_button_five_on_x() {
    let s = parse(r#"{"t":"scroll","x":0,"y":1,"dx":0,"dy":300}"#).unwrap();
    let a = &android(&s, 100, 200)[0];
    assert_eq!(a.len(), 21);
    assert!(i16::from_be_bytes(a[15..17].try_into().unwrap()) < 0);
    assert_eq!(
        desktop(&s, 100, 200),
        vec![vec!["mousemove", "0", "199", "click", "--repeat", "3", "5"]]
    );
}

#[test]
fn a_line_out_of_its_bounds_or_of_another_shape_is_refused_by_name() {
    assert!(parse(r#"{"t":"tap","x":1.5,"y":0}"#)
        .unwrap_err()
        .contains("bounds"));
    assert!(parse(r#"{"t":"tap","x":0.1,"y":0,"z":1}"#)
        .unwrap_err()
        .contains("not a BoxInput"));
    assert!(parse(r#"{"t":"swipe"}"#).is_err());
    assert!(parse(r#"{"t":"text","text":""}"#).is_err());
}
