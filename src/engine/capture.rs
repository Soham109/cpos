//! Local HTTP listener that receives problem data, CSES progress, and pending
//! submissions from the browser companion extension. Runs on `127.0.0.1` in a
//! background thread so the TUI event loop stays responsive.

use std::sync::{Arc, Mutex};
use std::sync::mpsc::Sender;
use std::time::{SystemTime, UNIX_EPOCH};

use tiny_http::{Header, Method, Response, Server};

use crate::data::config::Config;
use crate::data::models::{CapturedCsesProgress, CapturedProblem, PendingSubmit};

pub const DEFAULT_PORT: u16 = 27121;

/// Messages the capture server sends to the TUI event loop.
#[derive(Debug)]
pub enum CaptureMsg {
    Problem(CapturedProblem),
    CsesProgress(CapturedCsesProgress),
    ConfigChanged(Config),
}

#[derive(Debug, serde::Deserialize)]
struct SharedConfigUpdate {
    #[serde(default, alias = "defaultLanguage")]
    default_language: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    content: Option<String>,
}

/// Handle to the running capture server. Used to queue browser auto-submits.
pub struct CaptureServer {
    pub port: u16,
    pending: Arc<Mutex<Option<PendingSubmit>>>,
}

impl CaptureServer {
    pub fn set_pending_submit(&self, pending: PendingSubmit) {
        *self.pending.lock().unwrap() = Some(pending);
    }
}

fn cors_headers() -> Vec<Header> {
    vec![
        Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap(),
        Header::from_bytes("Access-Control-Allow-Methods", "GET, POST, OPTIONS").unwrap(),
        Header::from_bytes("Access-Control-Allow-Headers", "Content-Type").unwrap(),
        Header::from_bytes("Content-Type", "application/json").unwrap(),
    ]
}

fn json_response(status: u16, body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    let data = body.as_bytes().to_vec();
    let mut resp = Response::from_data(data).with_status_code(status);
    for h in cors_headers() {
        resp.add_header(h);
    }
    resp
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Try to start the capture listener on the default port. Returns `None` if
/// the port is already in use (another CPOS instance is running).
pub fn start(tx: Sender<CaptureMsg>) -> Option<CaptureServer> {
    start_on_port(tx, DEFAULT_PORT)
}

/// Start the capture listener on a specific port. Pass `0` for an OS-assigned
/// ephemeral port (used in tests so they never collide with a running instance
/// or with each other). Returns `None` if the port can't be bound. The returned
/// `CaptureServer.port` is the actual bound port.
pub fn start_on_port(tx: Sender<CaptureMsg>, port: u16) -> Option<CaptureServer> {
    let addr = format!("127.0.0.1:{port}");
    let server = match Server::http(&addr) {
        Ok(s) => s,
        Err(_) => return None,
    };

    let bound_port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .unwrap_or(port);

    let pending = Arc::new(Mutex::new(None));
    let pending_for_thread = pending.clone();
    std::thread::spawn(move || run(server, tx, pending_for_thread));
    Some(CaptureServer {
        port: bound_port,
        pending,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_server_starts_and_responds_to_health() {
        let (tx, _rx) = std::sync::mpsc::channel();
        // Ephemeral port (0) so the test never collides with a running CPOS
        // instance, a parallel test, or a leaked server thread from a prior test.
        let server = start_on_port(tx, 0).expect("server should start on an ephemeral port");
        let port = server.port;

        let resp = ureq_lite_get(port);
        assert!(resp.contains("\"status\":\"ok\""));
    }

    #[test]
    fn capture_server_receives_problem() {
        let (tx, rx) = std::sync::mpsc::channel();
        let server = start_on_port(tx, 0).expect("server should start on an ephemeral port");
        let port = server.port;

        let body = r#"{"platform":"codeforces","id":"4A","name":"Watermelon","url":"https://codeforces.com/problemset/problem/4/A","statementHtml":"<div class=\"problem-statement\"><p>Split it.</p></div>","tests":[{"input":"8","expected_output":"YES","input_block_sizes":[1],"output_block_sizes":[1],"input_output_offset":0}]}"#;
        let resp = ureq_lite_post(port, "/capture/problem", body);
        assert!(resp.contains("\"ok\":true"));

        let msg = rx.recv_timeout(std::time::Duration::from_secs(1)).unwrap();
        match msg {
            CaptureMsg::Problem(cap) => {
                assert_eq!(cap.id, "4A");
                assert_eq!(cap.tests.len(), 1);
                assert!(cap.statement_html.as_deref().unwrap().contains("Split it"));
                assert_eq!(cap.tests[0].input_block_sizes, vec![1]);
            }
            _ => panic!("expected Problem message"),
        }
    }

    fn ureq_lite_get(port: u16) -> String {
        use std::io::Read;
        let mut stream =
            std::net::TcpStream::connect(format!("127.0.0.1:{port}")).unwrap();
        std::io::Write::write_all(
            &mut stream,
            b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        )
        .unwrap();
        let mut buf = String::new();
        stream.read_to_string(&mut buf).unwrap();
        buf
    }

    fn ureq_lite_post(port: u16, path: &str, body: &str) -> String {
        use std::io::Read;
        let mut stream =
            std::net::TcpStream::connect(format!("127.0.0.1:{port}")).unwrap();
        let req = format!(
            "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        std::io::Write::write_all(&mut stream, req.as_bytes()).unwrap();
        let mut buf = String::new();
        stream.read_to_string(&mut buf).unwrap();
        buf
    }
}

/// Build the /recommend JSON: load the persisted cache, run the central
/// practice engine with the query's filters, serialize the report.
fn recommend_response(query_string: &str) -> anyhow::Result<String> {
    use crate::data::cache::Cache;
    use crate::data::models::Platform;
    use crate::engine::practice;

    let query = practice::parse_query(query_string);
    let cache = Cache::open()?;
    let mut problems = cache.get_problems(Platform::Codeforces)?;
    problems.extend(cache.get_problems(Platform::Cses)?);
    let submissions = cache.get_all_submissions()?;
    let contests = cache.get_contests(Platform::Codeforces)?;
    let official = cache
        .get_rating_history(Platform::Codeforces)?
        .last()
        .map(|r| r.new_rating);

    let report = practice::build_report(&problems, &submissions, &contests, official, &query);
    Ok(serde_json::json!({
        "ok": true,
        "summary": report.summary,
        "recs": report.recs,
    })
    .to_string())
}

#[cfg(test)]
mod recommend_tests {
    use super::*;

    /// Smoke-check the full endpoint path against the real local cache when one
    /// exists (skips cleanly on fresh machines/CI).
    #[test]
    fn recommend_response_serializes_against_local_cache() {
        let json = match recommend_response("mode=auto&count=5") {
            Ok(j) => j,
            Err(_) => return, // no cache on this machine
        };
        let v: serde_json::Value = serde_json::from_str(&json).expect("valid JSON");
        assert_eq!(v["ok"], true);
        assert!(v["summary"]["level"].is_number());
        if let Some(recs) = v["recs"].as_array() {
            for r in recs {
                assert!(r["problem"]["id"].is_string());
                assert!(r["reasons"].is_array());
            }
            eprintln!("sample recs against local cache:");
            for r in recs.iter().take(5) {
                eprintln!(
                    "  {} {} [{}] {} :: {}",
                    r["problem"]["id"], r["problem"]["name"], r["problem"]["rating"],
                    r["year"], r["reasons"]
                );
            }
            eprintln!("summary: level={} goal={} weak={:?}",
                v["summary"]["level"], v["summary"]["goal"],
                v["summary"]["weak_tags"].as_array().map(|a| a.iter().map(|t| t["tag"].to_string()).collect::<Vec<_>>()));
        }
    }
}

fn run(server: Server, tx: Sender<CaptureMsg>, pending: Arc<Mutex<Option<PendingSubmit>>>) {
    for mut request in server.incoming_requests() {
        if *request.method() == Method::Options {
            let _ = request.respond(json_response(204, ""));
            continue;
        }

        let url = request.url().to_string();
        // Route on the path only — /recommend carries a query string.
        let (path, query) = match url.split_once('?') {
            Some((p, q)) => (p.to_string(), q.to_string()),
            None => (url.clone(), String::new()),
        };

        match (request.method(), path.as_str()) {
            (&Method::Get, "/health") => {
                let _ = request.respond(json_response(
                    200,
                    r#"{"status":"ok","app":"cpos"}"#,
                ));
            }

            // The central practice engine over HTTP — the browser companion's
            // Recommend tab queries this. Reads the persisted cache directly on
            // this thread (same precedent as /config reading the config file).
            (&Method::Get, "/recommend") => {
                let body = match recommend_response(&query) {
                    Ok(json) => json,
                    Err(err) => serde_json::json!({
                        "ok": false,
                        "error": err.to_string(),
                    })
                    .to_string(),
                };
                let _ = request.respond(json_response(200, &body));
            }

            (&Method::Get, "/pending-submit") => {
                let guard = pending.lock().unwrap();
                match guard.as_ref() {
                    Some(p) if p.expires_at > now_ms() => {
                        let body = serde_json::to_string(p).unwrap_or_else(|_| "{}".into());
                        let _ = request.respond(json_response(200, &body));
                    }
                    _ => {
                        let _ = request.respond(json_response(404, r#"{"ok":false}"#));
                    }
                }
            }

            (&Method::Get, "/config") => match Config::load() {
                Ok(config) => {
                    let mut templates = std::collections::HashMap::new();
                    for lang in config.compile_commands.keys() {
                        if let Some(content) = config.read_template(lang) {
                            templates.insert(lang.clone(), content);
                        }
                    }
                    let body = serde_json::json!({
                        "ok": true,
                        "defaultLanguage": config.default_language,
                        "templates": templates,
                    })
                    .to_string();
                    let _ = request.respond(json_response(200, &body));
                }
                Err(e) => {
                    let body =
                        serde_json::json!({ "ok": false, "error": e.to_string() }).to_string();
                    let _ = request.respond(json_response(500, &body));
                }
            },

            (&Method::Post, "/config") => {
                let mut body = String::new();
                if request.as_reader().read_to_string(&mut body).is_err() {
                    let _ = request.respond(json_response(
                        400,
                        r#"{"ok":false,"error":"bad body"}"#,
                    ));
                    continue;
                }
                let update = match serde_json::from_str::<SharedConfigUpdate>(&body) {
                    Ok(update) => update,
                    Err(e) => {
                        let body =
                            serde_json::json!({ "ok": false, "error": e.to_string() }).to_string();
                        let _ = request.respond(json_response(400, &body));
                        continue;
                    }
                };
                match Config::load().and_then(|mut config| {
                    if let Some(lang) = update.default_language.filter(|s| !s.trim().is_empty()) {
                        config.default_language = lang;
                    }
                    if let (Some(lang), Some(content)) = (update.language, update.content) {
                        config.write_template(&lang, &content)?;
                    } else {
                        config.save()?;
                    }
                    Ok(config)
                }) {
                    Ok(config) => {
                        let _ = tx.send(CaptureMsg::ConfigChanged(config));
                        let _ = request.respond(json_response(200, r#"{"ok":true}"#));
                    }
                    Err(e) => {
                        let body =
                            serde_json::json!({ "ok": false, "error": e.to_string() }).to_string();
                        let _ = request.respond(json_response(500, &body));
                    }
                }
            }

            (&Method::Post, "/pending-submit/consumed") => {
                *pending.lock().unwrap() = None;
                let _ = request.respond(json_response(200, r#"{"ok":true}"#));
            }

            (&Method::Post, "/capture/problem") => {
                let mut body = String::new();
                if request.as_reader().read_to_string(&mut body).is_err() {
                    let _ = request.respond(json_response(400, r#"{"error":"bad body"}"#));
                    continue;
                }
                match serde_json::from_str::<CapturedProblem>(&body) {
                    Ok(cap) => {
                        let name = cap.name.clone();
                        let n_tests = cap.tests.len();
                        let _ = tx.send(CaptureMsg::Problem(cap));
                        let _ = request.respond(json_response(
                            200,
                            &format!(
                                r#"{{"ok":true,"name":"{name}","tests":{n_tests}}}"#
                            ),
                        ));
                    }
                    Err(e) => {
                        let _ = request.respond(json_response(
                            400,
                            &format!(r#"{{"error":"{}"}}"#, e),
                        ));
                    }
                }
            }

            (&Method::Post, "/capture/cses-progress") => {
                let mut body = String::new();
                if request.as_reader().read_to_string(&mut body).is_err() {
                    let _ = request.respond(json_response(400, r#"{"error":"bad body"}"#));
                    continue;
                }
                match serde_json::from_str::<CapturedCsesProgress>(&body) {
                    Ok(progress) => {
                        let n = progress.solved.len();
                        let _ = tx.send(CaptureMsg::CsesProgress(progress));
                        let _ = request.respond(json_response(
                            200,
                            &format!(r#"{{"ok":true,"solved":{n}}}"#),
                        ));
                    }
                    Err(e) => {
                        let _ = request.respond(json_response(
                            400,
                            &format!(r#"{{"error":"{}"}}"#, e),
                        ));
                    }
                }
            }

            _ => {
                let _ = request.respond(json_response(404, r#"{"error":"not found"}"#));
            }
        }
    }
}
