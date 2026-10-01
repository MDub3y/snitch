use axum::{extract::Query, routing::get, Router};
use serde::Deserialize;
use std::net::{IpAddr, ToSocketAddrs};

const ALLOWED_HOSTS: &[&str] = &["api.example.com", "cdn.example.com"];

#[derive(Deserialize)]
struct FetchParams {
    url: String,
}

fn resolve_first(host: &str) -> Option<IpAddr> {
    (host, 443).to_socket_addrs().ok()?.next().map(|a| a.ip())
}

// Same shape as the vulnerable fetcher, but the destination is validated:
// host allowlist, then private/loopback/link-local checks on the resolved IP.
async fn fetch_remote(Query(params): Query<FetchParams>) -> String {
    let parsed = match url::Url::parse(&params.url) {
        Ok(parsed) if parsed.scheme() == "https" => parsed,
        _ => return "forbidden".to_string(),
    };
    let host = parsed.host_str().unwrap_or_default();
    if !ALLOWED_HOSTS.contains(&host) {
        return "forbidden".to_string();
    }
    let Some(addr) = resolve_first(host) else {
        return "forbidden".to_string();
    };
    if addr.is_loopback() || match addr {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local(),
        IpAddr::V6(_) => false,
    } {
        return "forbidden".to_string();
    }
    let response = reqwest::get(parsed.as_str()).await.unwrap();
    response.text().await.unwrap()
}

#[tokio::main]
async fn main() {
    let app = Router::new().route("/fetch", get(fetch_remote));
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
