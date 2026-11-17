//! What the runner tells core about a box (`box-wire.ts` `boxReportSchema`), on the device's own
//! credential: `POST /api/boxes/:id/report`, and the span clip's multipart upload.

use std::future::Future;
use std::pin::Pin;

use runner_transport::api::{encode_form, FormPart};
use runner_transport::CoreClient;
use serde_json::Value;

pub type Fut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait Core: Send + Sync + 'static {
    fn report<'a>(&'a self, box_id: &'a str, body: Value) -> Fut<'a, ()>;
    fn clip<'a>(
        &'a self,
        box_id: &'a str,
        span_id: &'a str,
        clip: Vec<u8>,
        still: Vec<u8>,
    ) -> Fut<'a, Result<(), String>>;
}

impl Core for CoreClient {
    fn report<'a>(&'a self, box_id: &'a str, body: Value) -> Fut<'a, ()> {
        Box::pin(async move {
            let path = format!("/api/boxes/{box_id}/report");
            match self.post(&path).json(&body).send().await {
                Ok(r) if r.status().is_success() => {}
                Ok(r) => {
                    let status = r.status();
                    let text = r.text().await.unwrap_or_default();
                    tracing::warn!(
                        "[box] {box_id}: core answered the {} report {status}: {text}",
                        body["kind"]
                    );
                }
                Err(e) => tracing::warn!(
                    "[box] {box_id}: the {} report did not reach core: {e}",
                    body["kind"]
                ),
            }
        })
    }

    fn clip<'a>(
        &'a self,
        box_id: &'a str,
        span_id: &'a str,
        clip: Vec<u8>,
        still: Vec<u8>,
    ) -> Fut<'a, Result<(), String>> {
        Box::pin(async move {
            let parts = [
                FormPart {
                    name: "clip".into(),
                    filename: Some("clip.mp4".into()),
                    mime: Some("video/mp4".into()),
                    bytes: clip,
                },
                FormPart {
                    name: "still".into(),
                    filename: Some("still.png".into()),
                    mime: Some("image/png".into()),
                    bytes: still,
                },
            ];
            let (content_type, body) = encode_form(&parts);
            let path = format!("/api/boxes/{box_id}/spans/{span_id}/clip");
            let r = self
                .post(&path)
                .header("content-type", content_type)
                .body(body)
                .send()
                .await
                .map_err(|e| format!("the clip did not reach core: {e}"))?;
            if r.status().is_success() {
                Ok(())
            } else {
                let status = r.status();
                Err(format!(
                    "core refused the clip {status}: {}",
                    r.text().await.unwrap_or_default()
                ))
            }
        })
    }
}
