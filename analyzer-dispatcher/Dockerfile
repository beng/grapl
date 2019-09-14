FROM ekidd/rust-musl-builder

WORKDIR /tmp
RUN mkdir ./artifacts
COPY ./analyzer-dispatcher ./analyzer-dispatcher
COPY ./graph-descriptions ./analyzer-dispatcher/graph-descriptions

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

RUN cargo build --manifest-path analyzer-dispatcher/Cargo.toml --release
RUN cp analyzer-dispatcher/target/x86_64-unknown-linux-musl/release/analyzer-dispatcher ./artifacts