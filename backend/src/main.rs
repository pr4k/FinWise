use finwise_api::{AppState, connect, router};
use std::{net::SocketAddr, path::PathBuf};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let data = PathBuf::from(std::env::var("FINWISE_DATA_DIR").unwrap_or_else(|_| "data".into()));
    tokio::fs::create_dir_all(&data).await?;
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| format!("sqlite://{}", data.join("finwise.sqlite").display()));
    let address: SocketAddr = std::env::var("FINWISE_BIND")
        .unwrap_or_else(|_| "127.0.0.1:3000".into())
        .parse()?;
    let secure_cookies = std::env::var("FINWISE_INSECURE_LOCAL_COOKIES").as_deref() != Ok("true");
    if !secure_cookies && !address.ip().is_loopback() {
        return Err("Insecure cookies require a loopback bind address".into());
    }
    let pool = connect(&url).await?;
    let web = PathBuf::from(std::env::var("FINWISE_WEB_DIR").unwrap_or_else(|_| "web".into()));
    let listener = tokio::net::TcpListener::bind(address).await?;
    eprintln!("FinWise listening on {address}");
    axum::serve(
        listener,
        router(
            AppState {
                pool,
                secure_cookies,
            },
            &web,
        ),
    )
    .with_graceful_shutdown(async {
        #[cfg(unix)]
        {
            let mut terminate =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("register SIGTERM handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => (),
                _ = terminate.recv() => (),
            }
        }
        #[cfg(not(unix))]
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    Ok(())
}
