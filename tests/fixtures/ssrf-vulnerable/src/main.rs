use axum::{
    extract::{Json, Query},
    routing::{get, post},
    Router,
};
use serde::Deserialize;

mod proxy;

#[derive(Deserialize)]
struct FetchParams {
    url: String,
}

#[derive(Deserialize)]
struct WebhookConfig {
    callback_url: String,
}

// Direct SSRF: query parameter flows straight into reqwest::get.
async fn fetch_remote(Query(params): Query<FetchParams>) -> String {
    let response = reqwest::get(&params.url).await.unwrap();
    response.text().await.unwrap()
}

// Direct SSRF through a client method: JSON body field into client.post.
async fn register_webhook(Json(config): Json<WebhookConfig>) -> &'static str {
    let client = reqwest::Client::new();
    client.post(&config.callback_url).send().await.unwrap();
    "registered"
}

// Cross-file SSRF: the extractor is here, the sink lives in proxy.rs.
async fn mirror(Query(params): Query<FetchParams>) -> String {
    proxy::forward(&params.url).await
}

#[tokio::main]
async fn main() {
    let app = Router::new()
        .route("/fetch", get(fetch_remote))
        .route("/webhooks", post(register_webhook))
        .route("/mirror", get(mirror));
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
