# rucloud 映像：Rust 編譯的 rucloud + Node.js（跑 Worker 程式碼）
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src src
COPY runtime runtime
# rucloud init 的範本在編譯時嵌進執行檔
COPY templates templates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/rucloud /rucloud

FROM node:24-bookworm-slim
COPY --from=build /rucloud /usr/local/bin/rucloud
WORKDIR /srv
VOLUME /data
ENV RUCLOUD_LOG=info
ENTRYPOINT ["rucloud"]
CMD ["serve", "/etc/rucloud/rucloud.toml"]
