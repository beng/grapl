#!/usr/bin/env bash
cp -r "../graph-descriptions" . &&
cp -r "../graph-generator-lib"  . &&
docker run --rm -it -v "$(pwd)":/home/rust/src -t df6136cbfcc5 cargo build --release &&
cp "./target/x86_64-unknown-linux-musl/release/sysmon-subgraph-generator" "./bootstrap" &&
zip "./sysmon-subgraph-generator.zip" "./bootstrap" &&
cp "./sysmon-subgraph-generator.zip" "../grapl-cdk/"
rm "./sysmon-subgraph-generator.zip"
rm "./bootstrap"
date
