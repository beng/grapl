FROM ekidd/rust-musl-builder

WORKDIR /tmp
RUN mkdir ./artifacts
COPY ./generic-subgraph-generator ./generic-subgraph-generator
COPY ./graph-descriptions ./generic-subgraph-generator/graph-descriptions
COPY ./graph-generator-lib ./generic-subgraph-generator/graph-generator-lib

# if this chown is not present, will receive the below error.
# this chown needs to be run AFTER the files are copied over
# ```
#     Updating crates.io index
# error: failed to open: /tmp/target/release/.cargo-lock
#
# Caused by:
#   Permission denied (os error 13)
# ```
RUN sudo chown -R rust:rust .

RUN cargo build --manifest-path ./generic-subgraph-generator/Cargo.toml --release
RUN cp generic-subgraph-generator/target/x86_64-unknown-linux-musl/release/generic-subgraph-generator ./artifacts
