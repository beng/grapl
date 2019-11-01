FROM ekidd/rust-musl-builder as builder

# this should be passed in via Makefile using build-args
ARG SERVICE_NAME=sysmon-subgraph-generator

WORKDIR /tmp
RUN mkdir ./artifacts

COPY ./${SERVICE_NAME} ./${SERVICE_NAME}
COPY ./graph-descriptions ./${SERVICE_NAME}/graph-descriptions
COPY ./graph-generator-lib ./${SERVICE_NAME}/graph-generator-lib

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

# RUN cargo build --manifest-path ./sysmon-subgraph-generator/Cargo.toml --release
RUN cargo build --manifest-path ./${SERVICE_NAME}/Cargo.toml
RUN cp ${SERVICE_NAME}/target/x86_64-unknown-linux-musl/release/${SERVICE_NAME} ./artifacts

FROM lambci/lambda:provided
WORKDIR /tmp
COPY --from=builder /tmp/artifacts/${SERVICE_NAME}
