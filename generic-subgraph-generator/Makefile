SERVICE_NAME := generic-subgraph-generator

build-artifact:
	docker-compose build $(SERVICE_NAME)

fetch-artifact:
	mkdir -p ../artifacts/$(SERVICE_NAME)
	mkdir -p ./artifacts
	docker create --name extract-$(SERVICE_NAME) $(SERVICE_NAME):latest
	docker cp extract-$(SERVICE_NAME):/tmp/artifacts/$(SERVICE_NAME) ../artifacts/$(SERVICE_NAME)/bootstrap
	docker rm -f extract-$(SERVICE_NAME)
	cp ../artifacts/$(SERVICE_NAME)/bootstrap ./artifacts/

# this is only used for running locally as it depends on a aws lambda
# https://github.com/awslabs/aws-lambda-rust-runtime#docker
run:
	echo '{"name":"ben"}' |  \
	docker run -i \
		-v $(shell pwd)/artifacts:/var/task \
		-e DOCKER_LAMBDA_USE_STDIN=1 \
		-e AWS_REGION='us-east-1' \
		-e RUST_BACKTRACE=1 \
		lambci/lambda:provided \
		my_handler

prepare-deploy:
	zip ../artifacts/$(SERVICE_NAME)/$(SERVICE_NAME).zip \
		../artifacts/$(SERVICE_NAME)/bootstrap
	cp ../artifacts/$(SERVICE_NAME)/$(SERVICE_NAME).zip \
		../grapl-cdk
