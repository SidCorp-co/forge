//! The codec against the fixtures core's TypeScript codec reads, written by hand from the header
//! layout: every frame decodes to its frame and encodes back to its bytes, and every fault is
//! refused naming the stream its header names.

use super::*;

fn fixtures() -> serde_json::Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../contracts/fixtures/preview-tunnel-frames.json"
    );
    let text = std::fs::read_to_string(path).expect("the contract's tunnel fixtures are readable");
    serde_json::from_str(&text).expect("the fixtures are JSON")
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

fn frame_of(v: &serde_json::Value) -> Frame {
    let stream = v["streamId"].as_u64().expect("streamId") as u32;
    match v["type"].as_str().expect("type") {
        "open" => Frame::Open {
            stream,
            preview_id: v["previewId"].as_str().expect("previewId").into(),
        },
        "data" => Frame::Data {
            stream,
            bytes: unhex(v["bytesHex"].as_str().expect("bytesHex")),
        },
        "window" => Frame::Window {
            stream,
            delta: v["delta"].as_u64().expect("delta") as u32,
        },
        "close" => Frame::Close { stream },
        "reset" => {
            let name = v["code"].as_str().expect("code");
            let code = (1..=7)
                .filter_map(ResetCode::of)
                .find(|c| c.name() == name)
                .expect("a known reset code");
            Frame::Reset { stream, code }
        }
        other => panic!("fixture names frame type {other}"),
    }
}

#[test]
fn every_fixture_frame_decodes_and_encodes_to_the_contracts_bytes() {
    let all = fixtures();
    let frames = all["frames"].as_array().expect("frames");
    assert!(!frames.is_empty());
    for case in frames {
        let name = case["name"].as_str().unwrap_or("?");
        let bytes = unhex(case["hex"].as_str().expect("hex"));
        let want = frame_of(&case["frame"]);
        assert_eq!(decode(&bytes).as_ref(), Ok(&want), "{name}: decode");
        assert_eq!(
            encode(&want).as_deref(),
            Ok(bytes.as_slice()),
            "{name}: encode"
        );
    }
}

#[test]
fn every_fixture_fault_is_refused_naming_its_stream() {
    let all = fixtures();
    let faults = all["faults"].as_array().expect("faults");
    assert!(!faults.is_empty());
    for case in faults {
        let name = case["name"].as_str().unwrap_or("?");
        let bytes = unhex(case["hex"].as_str().expect("hex"));
        let want = case["streamId"].as_u64().map(|s| s as u32);
        match decode(&bytes) {
            Ok(frame) => panic!("{name}: decoded to {frame:?}, the contract refuses it"),
            Err(f) => assert_eq!(f.stream, want, "{name}: {}", f.detail),
        }
    }
}

#[test]
fn a_data_frame_carries_at_most_64_kib() {
    let full = Frame::Data {
        stream: 9,
        bytes: vec![7; MAX_DATA_BYTES],
    };
    let wire = encode(&full).expect("64 KiB is one frame");
    assert_eq!(decode(&wire), Ok(full));
    let over = Frame::Data {
        stream: 9,
        bytes: vec![7; MAX_DATA_BYTES + 1],
    };
    assert!(encode(&over).unwrap_err().contains("1..65536"));
    let empty = Frame::Data {
        stream: 9,
        bytes: vec![],
    };
    assert!(encode(&empty).is_err());
}

#[test]
fn stream_zero_and_a_preview_that_is_not_a_uuid_are_never_sent() {
    assert!(encode(&Frame::Close { stream: 0 }).is_err());
    let open = Frame::Open {
        stream: 1,
        preview_id: "p-1".into(),
    };
    assert!(encode(&open).unwrap_err().contains("not a uuid"));
}
