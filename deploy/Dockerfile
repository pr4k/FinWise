FROM rust:1.94-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY backend ./backend
RUN cargo build --locked --release -p finwise-api

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /app finwise \
    && mkdir -p /data && chown finwise:finwise /data
WORKDIR /app
COPY --from=builder /build/target/release/finwise-api /usr/local/bin/finwise-api
COPY --chown=finwise:finwise web /app/web
ENV FINWISE_BIND=0.0.0.0:3000 FINWISE_DATA_DIR=/data FINWISE_WEB_DIR=/app/web
USER finwise
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:3000/health/ready > /dev/null \
    && curl --fail --silent http://127.0.0.1:3000/ > /dev/null || exit 1
ENTRYPOINT ["finwise-api"]
