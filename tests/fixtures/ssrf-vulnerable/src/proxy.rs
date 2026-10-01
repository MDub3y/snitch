// Outbound request helper: no validation of the destination.
pub async fn forward(url: &str) -> String {
    let response = reqwest::get(url).await.unwrap();
    response.text().await.unwrap()
}
