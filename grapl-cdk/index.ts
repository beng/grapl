const AWS = require('aws-sdk');
const child_process = require("child_process");

import sagemaker = require('@aws-cdk/aws-sagemaker');
import cloudmap = require('@aws-cdk/aws-servicediscovery');
import s3Subs = require('@aws-cdk/aws-s3-notifications');
import s3deploy = require('@aws-cdk/aws-s3-deployment');
import snsSubs = require('@aws-cdk/aws-sns-subscriptions');
import elasticache = require('@aws-cdk/aws-elasticache');
import cdk = require('@aws-cdk/core');
import s3 = require('@aws-cdk/aws-s3');
import sns = require('@aws-cdk/aws-sns');
import sqs = require('@aws-cdk/aws-sqs');
import ec2 = require('@aws-cdk/aws-ec2');
import servicediscovery = require('@aws-cdk/aws-servicediscovery');
import lambda = require('@aws-cdk/aws-lambda');
import iam = require('@aws-cdk/aws-iam');
import dynamodb = require('@aws-cdk/aws-dynamodb');
import ecs = require('@aws-cdk/aws-ecs');
import route53 = require('@aws-cdk/aws-route53');

import apigateway = require('@aws-cdk/aws-apigateway');
import {SqsEventSource} from '@aws-cdk/aws-lambda-event-sources';
import {IVpc, Port, Vpc} from "@aws-cdk/aws-ec2";
import {IBucket} from "@aws-cdk/aws-s3";
import {ITopic} from "@aws-cdk/aws-sns";
import {Runtime} from "@aws-cdk/aws-lambda";
import {Duration, Token} from '@aws-cdk/core';
import {PublicHostedZone} from "@aws-cdk/aws-route53";

const env = require('node-env-file');


class RedisCluster extends cdk.Construct {
    securityGroup: ec2.SecurityGroup;
    connections: ec2.Connections;
    cluster: elasticache.CfnCacheCluster;

    constructor(scope, id: string, vpc: ec2.Vpc) {
        super(scope, id);

        // Define a group for telling Elasticache which subnets to put cache nodes in.
        const subnetGroup = new elasticache.CfnSubnetGroup(this, `${id}-subnet-group`, {
            description: `List of subnets used for redis cache ${id}`,
            subnetIds: vpc.privateSubnets.map(function (subnet) {
                return subnet.subnetId;
            }),
            cacheSubnetGroupName: id + 'SubnetGroupName'
        });

        // The security group that defines network level access to the cluster
        this.securityGroup = new ec2.SecurityGroup(this, `${id}-security-group`, {vpc: vpc});

        this.connections = new ec2.Connections({
            securityGroups: [this.securityGroup],
            defaultPort: ec2.Port.tcp(6379)
        });

        // The cluster resource itself.
        this.cluster = new elasticache.CfnCacheCluster(this, `${id}-cluster`, {
            cacheNodeType: 'cache.t2.small',
            engine: 'redis',
            numCacheNodes: 1,
            autoMinorVersionUpgrade: true,
            cacheSubnetGroupName: subnetGroup.cacheSubnetGroupName,
            vpcSecurityGroupIds: [
                this.securityGroup.securityGroupId
            ]
        });
    }
}


class Queues {
    queue: sqs.Queue;
    retry_queue: sqs.Queue;
    dead_letter_queue: sqs.Queue;

    constructor(stack: cdk.Stack, queue_name: string) {
        this.dead_letter_queue = new sqs.Queue(stack, queue_name + '-dead-letter');

        this.retry_queue = new sqs.Queue(stack, queue_name + '-retry', {
            deadLetterQueue: {queue: this.dead_letter_queue, maxReceiveCount: 10},
            visibilityTimeout: Duration.seconds(240)
        });

        this.queue = new sqs.Queue(stack, queue_name, {
            deadLetterQueue: {queue: this.retry_queue, maxReceiveCount: 5},
            visibilityTimeout: Duration.seconds(180)
        });

    }
}


class EngagementEdge extends cdk.Stack {
    event_handler: lambda.Function;
    integration: apigateway.LambdaRestApi;
    name: string;
    integrationName: string;

    constructor(
        parent: cdk.App,
        name: string,
        hostname: string,
        engagement_graph: DGraphFargate,
        vpc: ec2.Vpc
    ) {
        super(parent, name + '-stack');
        this.name = name;
        this.integrationName = name + 'Integration';

        this.event_handler = new lambda.Function(
            this, name, {
                runtime: Runtime.PYTHON_3_7,
                handler: `engagement_edge.lambda_handler`,
                code: lambda.Code.asset(`./engagement_edge.zip`),
                vpc: vpc,
                environment: {
                    "EG_ALPHAS": engagement_graph.alphaNames.join(","),
                },
                timeout: Duration.seconds(25),
                memorySize: 256,
            }
        );

        this.integration = new apigateway.LambdaRestApi(
            this,
            this.integrationName,
            {
                handler: this.event_handler,
            },

        );
    }
}


class Service {
    event_handler: lambda.Function;
    event_retry_handler: lambda.Function;
    queues: Queues;

    constructor(stack: cdk.Stack, name: string, environment?: any, vpc?: IVpc, retry_code_name?: string, opt?: any) {
        let runtime = null;
        if (opt && opt.runtime) {
            runtime = opt.runtime
        } else {
            runtime = {name: "provided", supportsInlineCode: true}
        }

        let handler = null;
        if (runtime === Runtime.PYTHON_3_7) {
            handler = `${name}.lambda_handler`
        } else {
            handler = name
        }

        const queues = new Queues(stack, name + '-queue');

        if (environment) {
            environment.QUEUE_URL = queues.queue.queueUrl;
            environment.RUST_BACKTRACE = "1";
        }

        let event_handler = new lambda.Function(
            stack, name, {
                runtime: runtime,
                handler: handler,
                code: lambda.Code.asset(`./${name}.zip`),
                vpc: vpc,
                environment: environment,
                timeout: Duration.seconds(180),
                memorySize: 256,
            }
        );

        if (!retry_code_name) {
            retry_code_name = name
        }


        if (environment) {
            environment.QUEUE_URL = queues.retry_queue.queueUrl;
        }

        let event_retry_handler = new lambda.Function(
            stack, name + '-retry-handler', {
                runtime: runtime,
                handler: handler,
                code: lambda.Code.asset(`./${retry_code_name}.zip`),
                vpc: vpc,
                environment: environment,
                timeout: Duration.seconds(240),
                memorySize: 512,
            }
        );

        event_handler.addEventSource(new SqsEventSource(queues.queue, {batchSize: 1}));
        event_retry_handler.addEventSource(new SqsEventSource(queues.retry_queue, {batchSize: 1}));

        queues.queue.grantConsumeMessages(event_handler);
        queues.retry_queue.grantConsumeMessages(event_retry_handler);

        this.queues = queues;
        this.event_handler = event_handler;
        this.event_retry_handler = event_retry_handler;
    }

    readsFrom(bucket: IBucket, with_list?: Boolean) {
        let policy = new iam.PolicyStatement();
        policy.addActions('s3:GetObject', 's3:ActionGetBucket');

        if (with_list === true) {
            policy.addActions('s3:ListObjects')
        }

        policy.addResources(bucket.bucketArn);

        this.event_handler.addToRolePolicy(policy);
        this.event_retry_handler.addToRolePolicy(policy);

        // TODO: This is adding more permissions than necessary
        bucket.grantRead(this.event_handler.role);
        bucket.grantRead(this.event_retry_handler.role);
    }

    publishesToTopic(publishes_to: ITopic) {
        const topicPolicy = new iam.PolicyStatement();

        topicPolicy.addActions('sns:CreateTopic');
        topicPolicy.addResources(publishes_to.topicArn);

        this.event_handler.addToRolePolicy(topicPolicy);

        this.event_retry_handler.addToRolePolicy(topicPolicy);

        publishes_to.grantPublish(this.event_handler.role);
        publishes_to.grantPublish(this.event_retry_handler.role);
    }

    publishesToBucket(publishes_to: IBucket) {

        publishes_to.grantWrite(this.event_handler.role);
        publishes_to.grantWrite(this.event_retry_handler.role);

    }
}


class SessionIdentityCache extends cdk.Stack {
    constructor(parent: cdk.App, vpc: ec2.Vpc) {
        super(parent, 'session-identity-cache-stack');

        // const zone = new route53.PrivateHostedZone(this, 'HostedZone', {
        //     zoneName: 'sessionid.cache',
        //     vpc_props
        // });


    }

}

class EventEmitter {
    bucket: s3.Bucket;
    topic: sns.Topic;
    constructor(stack: cdk.Stack, eventName: string) {

        this.bucket =
            new s3.Bucket(stack, eventName + '-bucket', {
                bucketName: process.env.BUCKET_PREFIX+ eventName + "-bucket"
            });

        // SNS Topics
        this.topic =
            new sns.Topic(stack, `${eventName}-topic`, {
                topicName: `${eventName}-topic`
            });

        this.bucket
            .addEventNotification(
                s3.EventType.OBJECT_CREATED,
                new s3Subs.SnsDestination(this.topic)
            );
    }
}

class EventEmitters extends cdk.Stack {
    raw_logs_bucket: s3.Bucket;
    sysmon_logs_bucket: s3.Bucket;
    identity_mappings_bucket: s3.Bucket;
    unid_subgraphs_generated_bucket: s3.Bucket;
    subgraphs_generated_bucket: s3.Bucket;
    analyzers_bucket: s3.Bucket;
    dispatched_analyzer_bucket: s3.Bucket;
    analyzer_matched_subgraphs_bucket: s3.Bucket;

    incident_topic: sns.Topic;
    identity_mappings_topic: sns.Topic;
    raw_logs_topic: sns.Topic;
    sysmon_logs_topic: sns.Topic;
    unid_subgraphs_generated_topic: sns.Topic;
    subgraphs_generated_topic: sns.Topic;
    subgraph_merged_topic: sns.Topic;
    dispatched_analyzer_topic: sns.Topic;
    analyzer_matched_subgraphs_topic: sns.Topic;
    engagements_created_topic: sns.Topic;

    constructor(parent: cdk.App, id: string) {
        super(parent, id + '-stack');
        let raw_logs_bucket = new s3.Bucket(
            this,
            id + '-raw-log-bucket',
            {
                bucketName: process.env.BUCKET_PREFIX + "-raw-log-bucket"
            });

        let sysmon_logs_bucket = new s3.Bucket(
            this,
            id + '-sysmon-log-bucket',
            {
                bucketName: process.env.BUCKET_PREFIX + "-sysmon-log-bucket"
            });

        let identity_mappings_bucket = new s3.Bucket(
            this,
            id + '-identity-mappings-bucket',
            {
                bucketName: process.env.BUCKET_PREFIX + "-identity-mappings-bucket"
            });

        let unid_subgraphs_generated_bucket = new s3.Bucket(
            this,
            id + '-unid-subgraphs-generated-bucket',
            {
                bucketName: process.env.BUCKET_PREFIX + "-unid-subgraphs-generated-bucket"
            }
        );
        let subgraphs_generated_bucket =
            new s3.Bucket(this, id + '-subgraphs-generated-bucket', {
                bucketName: process.env.BUCKET_PREFIX + "-subgraphs-generated-bucket"
            });

        let analyzers_bucket =
            new s3.Bucket(this, id + '-analyzers-bucket', {
                bucketName: process.env.BUCKET_PREFIX + "-analyzers-bucket"
            });


        let dispatched_analyzer_bucket =
            new s3.Bucket(this, id + '-dispatched-analyzer-bucket', {
                bucketName: process.env.BUCKET_PREFIX + "-dispatched-analyzer-bucket"
            });

        let analyzer_matched_subgraphs_bucket =
            new s3.Bucket(this, id + '-analyzer-matched-subgraphs-bucket', {
                bucketName: process.env.BUCKET_PREFIX + "-analyzer-matched-subgraphs-bucket"
            });

        // SNS Topics
        let incident_topic =
            new sns.Topic(this, id + '-incident-topic', {
                topicName: 'incident-topic'
            });
        let raw_logs_topic =
            new sns.Topic(this, id + '-raw-log-topic', {
                topicName: 'raw-log-topic'
            });
        let sysmon_logs_topic =
            new sns.Topic(this, id + '-sysmon-log-topic', {
                topicName: 'sysmon-log-topic'
            });
        let identity_mappings_topic =
            new sns.Topic(this, id + '-identity-mappings-topic', {
                topicName: 'identity-mappings-topic'
            });
        let unid_subgraphs_generated_topic =
            new sns.Topic(this, id + '-unid-subgraphs-generated-topic', {
                topicName: 'unid-subgraphs-generated-topic'
            });
        let subgraphs_generated_topic =
            new sns.Topic(this, id + '-subgraphs-generated-topic', {
                topicName: 'subgraphs-generated-topic'
            });
        let subgraph_merged_topic =
            new sns.Topic(this, id + '-subgraphs-merged-topic', {
                topicName: 'subgraphs-merged-topic'
            });
        let dispatched_analyzer_topic =
            new sns.Topic(this, id + '-dispatched-analyzer-topic', {
                topicName: 'dispatched-analyzer-topic'
            });

        let analyzer_matched_subgraphs_topic =
            new sns.Topic(this, id + '-analyzer-matched-subgraphs-topic', {
                topicName: 'analyzer-matched-subgraphs-topic'
            });
        let engagements_created_topic =
            new sns.Topic(this, id + '-engagements-created-topic', {
                topicName: 'engagements-created-topic'
            });


        // S3 -> SNS Events

        raw_logs_bucket
            .addEventNotification(
                s3.EventType.OBJECT_CREATED,
                new s3Subs.SnsDestination(raw_logs_topic)
            );
        sysmon_logs_bucket
            .addEventNotification(
                s3.EventType.OBJECT_CREATED,
                new s3Subs.SnsDestination(sysmon_logs_topic)
            );
        identity_mappings_bucket
            .addEventNotification(
                s3.EventType.OBJECT_CREATED,
                new s3Subs.SnsDestination(identity_mappings_topic)
            );
        unid_subgraphs_generated_bucket
            .addEventNotification(
                s3.EventType.OBJECT_CREATED,
                new s3Subs.SnsDestination(unid_subgraphs_generated_topic)
            );
        subgraphs_generated_bucket
            .addEventNotification(
                s3.EventType.OBJECT_CREATED,
                new s3Subs.SnsDestination(subgraphs_generated_topic)
            );
        dispatched_analyzer_bucket
            .addEventNotification(
                s3.EventType.OBJECT_CREATED,
                new s3Subs.SnsDestination(dispatched_analyzer_topic)
            );
        analyzer_matched_subgraphs_bucket
            .addEventNotification(
                s3.EventType.OBJECT_CREATED,
                new s3Subs.SnsDestination(analyzer_matched_subgraphs_topic)
            );

        this.raw_logs_bucket = raw_logs_bucket;
        this.sysmon_logs_bucket = sysmon_logs_bucket;
        this.identity_mappings_bucket = identity_mappings_bucket;
        this.unid_subgraphs_generated_bucket = unid_subgraphs_generated_bucket;
        this.subgraphs_generated_bucket = subgraphs_generated_bucket;
        this.analyzers_bucket = analyzers_bucket;
        this.dispatched_analyzer_bucket = dispatched_analyzer_bucket;
        this.analyzer_matched_subgraphs_bucket = analyzer_matched_subgraphs_bucket;

        this.incident_topic = incident_topic;
        this.raw_logs_topic = raw_logs_topic;
        this.sysmon_logs_topic = sysmon_logs_topic;
        this.identity_mappings_topic = identity_mappings_topic;
        this.unid_subgraphs_generated_topic = unid_subgraphs_generated_topic;
        this.subgraphs_generated_topic = subgraphs_generated_topic;
        this.subgraph_merged_topic = subgraph_merged_topic;
        this.dispatched_analyzer_topic = dispatched_analyzer_topic;
        this.analyzer_matched_subgraphs_topic = analyzer_matched_subgraphs_topic;
        this.engagements_created_topic = engagements_created_topic;
    }
}

class SysmonSubgraphGenerator extends cdk.Stack {

    constructor(parent: cdk.App, id: string,
                reads_from: s3.IBucket,
                subscribes_to: sns.Topic,
                writes_to: s3.IBucket,
    ) {
        super(parent, id + '-stack');

        const environment = {
            "BUCKET_PREFIX": process.env.BUCKET_PREFIX,
        };

        const service = new Service(this, 'sysmon-subgraph-generator', environment);

        service.readsFrom(reads_from);
        addSubscription(this, subscribes_to, new snsSubs.SqsSubscription(service.queues.queue));
        service.publishesToBucket(writes_to);
    }
}


class GenericSubgraphGenerator extends cdk.Stack {

    constructor(parent: cdk.App, id: string,
                reads_from: s3.IBucket,
                subscribes_to: sns.Topic,
                writes_to: s3.IBucket,
    ) {
        super(parent, id + '-stack');

        const environment = {
            "BUCKET_PREFIX": process.env.BUCKET_PREFIX
        };

        const service = new Service(this, 'generic-subgraph-generator', environment);

        service.readsFrom(reads_from);

        addSubscription(this, subscribes_to, new snsSubs.SqsSubscription(service.queues.queue));

        service.publishesToBucket(writes_to);
    }
}

function addSubscription(scope, topic, subscription) {
    const config = subscription.bind(topic);

    new sns.Subscription(scope, 'Subscription', {
        topic: topic,
        endpoint: config.endpoint,
        filterPolicy: config.filterPolicy,
        protocol: config.protocol,
        rawMessageDelivery: config.rawMessageDelivery
    });
}


class NodeIdentityMapper extends cdk.Stack {

    constructor(parent: cdk.App, id: string,
                reads_from: s3.IBucket,
                subscribes_to: sns.Topic,
                vpc: ec2.Vpc
    ) {
        super(parent, id + '-stack');


        const environment = {
            "BUCKET_PREFIX": process.env.BUCKET_PREFIX
        };

        let service = new Service(this, 'node-identity-mapper', environment, vpc);


        service.readsFrom(reads_from);

        addSubscription(this, subscribes_to, new snsSubs.SqsSubscription(service.queues.queue));

        service.event_handler.connections.allowToAnyIpv4(ec2.Port.tcp(443), 'Allow outbound to S3');
        service.event_retry_handler.connections.allowToAnyIpv4(ec2.Port.tcp(443), 'Allow outbound to S3');
    }
}


class NodeIdentifier extends cdk.Stack {

    constructor(parent: cdk.App, id: string,
                reads_from: s3.IBucket,
                subscribes_to: sns.Topic,
                writes_to: s3.IBucket,
                history_db: HistoryDb,
                vpc: ec2.Vpc
    ) {
        super(parent, id + '-stack');


        const environment = {
            "BUCKET_PREFIX": process.env.BUCKET_PREFIX,
            "IDENTITY_CACHE_PEPPER": process.env.IDENTITY_CACHE_PEPPER,
        };

        const service = new Service(this, 'node-identifier', environment, vpc, 'node-identifier-retry-handler');
        service.readsFrom(reads_from);

        history_db.allowReadWrite(service);
        service.publishesToBucket(writes_to);
        addSubscription(this, subscribes_to, new snsSubs.SqsSubscription(service.queues.queue));
        service.event_handler.connections.allowToAnyIpv4(ec2.Port.tcp(443), 'Allow outbound to S3');
        service.event_retry_handler.connections.allowToAnyIpv4(ec2.Port.tcp(443), 'Allow outbound to S3');

    }
}

class GraphMerger extends cdk.Stack {

    constructor(parent: cdk.App,
                id: string,
                reads_from: s3.IBucket,
                subscribes_to: sns.ITopic,
                publishes_to: sns.ITopic,
                master_graph: DGraphFargate,
                vpc: ec2.Vpc
    ) {
        super(parent, id + '-stack');

        const environment = {
            "SUBGRAPH_MERGED_TOPIC_ARN": publishes_to.topicArn,
            "BUCKET_PREFIX": process.env.BUCKET_PREFIX,
            "MG_ALPHAS": master_graph.alphaNames.join(",")
        };

        const service = new Service(this, 'graph-merger', environment, vpc);

        service.readsFrom(reads_from);
        service.publishesToTopic(publishes_to);

        addSubscription(this, subscribes_to, new snsSubs.SqsSubscription(service.queues.queue));
        //
        // service.event_handler.connections
        //     .allowToAnyIpv4(new ec2.Port({
        //
        //     }), 'Allow outbound to S3');
        // service.event_retry_handler.connections
        //     .allowToAnyIpv4(ec2.Port.allTcp(), 'Allow outbound to S3');

    }
}


class AnalyzerDispatch extends cdk.Stack {

    constructor(parent: cdk.App,
                id: string,
                subscribes_to: sns.ITopic,  // The SNS Topic that we must subscribe to our queue
                writes_to: s3.IBucket,
                reads_from: s3.IBucket,
                vpc: ec2.Vpc
    ) {
        super(parent, id + '-stack');


        const environment = {
            "DISPATCHED_ANALYZER_BUCKET": writes_to.bucketName,
            "BUCKET_PREFIX": process.env.BUCKET_PREFIX
        };

        const service = new Service(this, 'analyzer-dispatcher', environment, vpc);

        service.publishesToBucket(writes_to);
        // We need the List capability to find each of the analyzers
        service.readsFrom(reads_from, true);

        addSubscription(this, subscribes_to, new snsSubs.SqsSubscription(service.queues.queue));

        service.event_handler.connections.allowToAnyIpv4(ec2.Port.allTcp(), 'Allow outbound to S3');
        service.event_retry_handler.connections.allowToAnyIpv4(ec2.Port.allTcp(), 'Allow outbound to S3');
    }
}

class AnalyzerExecutor extends cdk.Stack {
    count_cache: RedisCluster;
    message_cache: RedisCluster;
    hit_cache: RedisCluster;

    constructor(parent: cdk.App,
                id: string,
                subscribes_to: sns.ITopic,
                reads_analyzers_from: s3.IBucket,
                reads_events_from: s3.IBucket,
                writes_events_to: s3.IBucket,
                master_graph: DGraphFargate,
                vpc: ec2.Vpc
    ) {
        super(parent, id + '-stack');

        this.count_cache = new RedisCluster(this, id + 'countcache', vpc);
        this.hit_cache = new RedisCluster(this, id + 'hitcache', vpc);
        this.message_cache = new RedisCluster(this, id + 'msgcache', vpc);

        const environment = {
            "ANALYZER_MATCH_BUCKET": writes_events_to.bucketName,
            "BUCKET_PREFIX": process.env.BUCKET_PREFIX,
            "MG_ALPHAS": master_graph.alphaNames.join(","),
            "COUNTCACHE_ADDR": this.count_cache.cluster.attrRedisEndpointAddress,
            "COUNTCACHE_PORT": this.count_cache.cluster.attrRedisEndpointPort,
            "MESSAGECACHE_ADDR": this.message_cache.cluster.attrRedisEndpointAddress,
            "MESSAGECACHE_PORT": this.message_cache.cluster.attrRedisEndpointPort,
            "HITCACHE_ADDR": this.hit_cache.cluster.attrRedisEndpointAddress,
            "HITCACHE_PORT": this.hit_cache.cluster.attrRedisEndpointPort,
            "GRPC_ENABLE_FORK_SUPPORT": "1",
        };

        const service = new Service(this, 'analyzer-executor', environment, vpc, null, {
            runtime: Runtime.PYTHON_3_7
        });

        this.count_cache.connections.allowFromAnyIpv4(Port.tcp(6379));
        this.hit_cache.connections.allowFromAnyIpv4(Port.tcp(6379));
        this.message_cache.connections.allowFromAnyIpv4(Port.tcp(6379));

        service.publishesToBucket(writes_events_to);
        // We need the List capability to find each of the analyzers
        service.readsFrom(reads_analyzers_from, true);
        service.readsFrom(reads_events_from);

        // Need to be able to GetObject in order to HEAD, can be replaced with
        // a cache later, but safe so long as there is no LIST
        let policy = new iam.PolicyStatement();
        policy.addActions('s3:GetObject');

        policy.addResources(writes_events_to.bucketArn);

        service.event_handler.addToRolePolicy(policy);
        service.event_retry_handler.addToRolePolicy(policy);

        addSubscription(this, subscribes_to, new snsSubs.SqsSubscription(service.queues.queue));

        service.event_handler.connections.allowToAnyIpv4(ec2.Port.allTraffic(), 'Allow outbound to S3');
        service.event_retry_handler.connections.allowToAnyIpv4(ec2.Port.allTraffic(), 'Allow outbound to S3');
    }
}

class EngagementCreator extends cdk.Stack {

    constructor(parent: cdk.App,
                id: string,
                reads_from: s3.IBucket,
                subscribes_to: sns.Topic,
                publishes_to: sns.Topic,
                master_graph: DGraphFargate,
                engagement_graph: DGraphFargate,
                vpc: ec2.Vpc,
    ) {
        super(parent, id + '-stack');

        const environment = {
            "MG_ALPHAS": master_graph.alphaNames.join(","),
            "EG_ALPHAS": engagement_graph.alphaNames.join(","),
        };

        const service = new Service(this, 'engagement-creator', environment, vpc, null, {
            runtime: Runtime.PYTHON_3_7
        });

        // master_graph.addAccessFrom(service);
        // engagement_graph.addAccessFrom(service);

        service.readsFrom(reads_from);
        service.publishesToTopic(publishes_to);

        addSubscription(this, subscribes_to, new snsSubs.SqsSubscription(service.queues.queue));

        service.event_handler.connections.allowToAnyIpv4(ec2.Port.allTcp(), 'Allow outbound to S3');
        service.event_retry_handler.connections.allowToAnyIpv4(ec2.Port.allTcp(), 'Allow outbound to S3');

    }
}


class Networks extends cdk.Stack {
    grapl_vpc: ec2.Vpc;

    constructor(parent: cdk.App, id: string,) {
        super(parent, id + '-stack');

        this.grapl_vpc = new ec2.Vpc(this, 'GraplVPC', {
            natGateways: 1,
            enableDnsHostnames: true,
            enableDnsSupport: true,
        });
    }
}


class Zero {
    name: string;

    constructor(
        parent: cdk.App,
        stack: cdk.Stack,
        graph: string,
        id: string,
        cluster: ecs.Cluster,
        peer: string,
        idx) {

        const zeroTask = new ecs.FargateTaskDefinition(
            stack,
            id,
            {
                cpu: 1024,
                memoryLimitMiB: 2048,
            }
        );

        let command = ["dgraph", "zero", `--my=${id}.${graph}.grapl:5080`,
            "--replicas=3",
            `--idx=${idx}`,
            "--alsologtostderr"];

        if (peer) {
            command.push(`--peer=${peer}.${graph}.grapl:5080`);
        }


        // const logDriver = new ecs.AwsLogDriver(stack, graph+id+'LogGroup', {
        //     streamPrefix: graph+id,
        // });

        zeroTask.addContainer(id + 'Container', {

            // --my is our own hostname (graph + id)
            // --peer is the other dgraph zero hostname
            image: ecs.ContainerImage.fromRegistry("dgraph/dgraph"),
            command,
            // logging: logDriver
        });


        const zeroService = new ecs.FargateService(stack, id + 'Service', {
            cluster,  // Required
            taskDefinition: zeroTask,
            cloudMapOptions: {
                name: id,
                dnsRecordType: servicediscovery.DnsRecordType.A,
                dnsTtl: Duration.seconds(300),
            }
        });

        this.name = `${id}.${graph}.grapl`;

        zeroService.connections.allowFromAnyIpv4(
            ec2.Port.allTcp()
        );
    }
}


class Alpha {
    name: string;

    constructor(
        parent: cdk.App,
        stack: cdk.Stack,
        graph: string,
        id: string,
        cluster: ecs.Cluster,
        zero: string) {

        const alphaTask = new ecs.FargateTaskDefinition(
            stack,
            id,
            {
                cpu: 4096,
                memoryLimitMiB: 8192,
            }
        );

        // const logDriver = new ecs.AwsLogDriver(stack, graph+id+'LogGroup', {
        //     streamPrefix: graph+id,
        // });

        alphaTask.addContainer(id + graph + 'Container', {
            image: ecs.ContainerImage.fromRegistry("dgraph/dgraph"),
            command: ["dgraph", "alpha", `--my=${id}.${graph}.grapl:7080`,
                "--lru_mb=1024", `--zero=${zero}.${graph}.grapl:5080`,
                "--alsologtostderr"
            ],
            // logging: logDriver
        });

        const alphaService = new ecs.FargateService(stack, id + 'Service', {
            cluster,  // Required
            taskDefinition: alphaTask,
            cloudMapOptions: {
                name: id,
                dnsRecordType: servicediscovery.DnsRecordType.A,
                dnsTtl: Duration.seconds(300),
            }
        });

        this.name = `${id}.${graph}.grapl`;

        alphaService.connections.allowFromAnyIpv4(ec2.Port.allTcp());
    }
}

class DGraphFargate extends cdk.Stack {
    cluster: ecs.Cluster;
    alphaNames: string[];

    constructor(
        parent: cdk.App,
        id: string,
        vpc: ec2.Vpc,
        zeroCount,
        alphaCount
    ) {
        super(parent, id + '-stack');

        const cluster = new ecs.Cluster(this, id + '-FargateCluster', {
            vpc: vpc
        });
        cluster.connections.allowInternally(Port.allTcp());

        this.cluster = cluster;

        const namespace = cluster.addDefaultCloudMapNamespace(
            {
                name: id + '.grapl',
                type: cloudmap.NamespaceType.DNS_PRIVATE,
                vpc
            }
        );

        const zero0 = new Zero(
            parent,
            this,
            id,
            'zero0',
            cluster,
            null,
            1
        );

        for (let i = 1; i < zeroCount; i++) {
            new Zero(
                parent,
                this,
                id,
                `zero${i}`,
                cluster,
                'zero0',
                1 + i
            );
        }

        this.alphaNames = [];

        for (let i = 0; i < alphaCount; i++) {

            const alpha = new Alpha(
                parent,
                this,
                id,
                `alpha${i}`, // increment for each alpha
                cluster,
                "zero0"
            );

            this.alphaNames.push(alpha.name);
        }

    }
}


class EngagementNotebook extends cdk.Stack {
    securityGroup: ec2.SecurityGroup;
    connections: ec2.Connections;

    constructor(parent: cdk.App,
                id: string,
                vpc: ec2.Vpc,
    ) {
        super(parent, id + '-notebook-stack');

        this.securityGroup = new ec2.SecurityGroup(this, `${id}-notebook-security-group`, {vpc: vpc});

        this.connections = new ec2.Connections({
            securityGroups: [this.securityGroup],
            defaultPort: ec2.Port.allTcp()
        });

        const role = new iam.Role(
            this,
            id + 'notebook-role',
            {
                assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com')
            }
        );

        const notebook = new sagemaker.CfnNotebookInstance(
            this,
            id + '-sagemaker-endpoint',
            {
                instanceType: 'ml.c4.2xlarge',
                securityGroupIds: [this.securityGroup.securityGroupId],
                subnetId: vpc.privateSubnets[0].subnetId,
                directInternetAccess: 'Enabled',
                roleArn: role.roleArn
            }
        );


    }
}

const fs = require('fs'),
      path = require('path');

const replaceInFile = (toModify, toReplace, replaceWith) => {
    return fs.readFile(toModify, 'utf8', (err, data) => {
        if (err) {
            return console.log(err);
        }
        const replaced = data.replace(toReplace, replaceWith);
        if (replaced === data) {
            console.log(`No replaced text - did you forget to build engagement ux?`)
        }
        fs.writeFile(toModify, replaced, 'utf8', (err) => {
            if (err) return console.log(err);
        });
    });
};

const getEdgeGatewayId = (integrationName: string, cb) =>{
    let apigateway = new AWS.APIGateway();

    apigateway.getRestApis({}, function(err, data) {
        if (err) {console.log('Error getting edge gateway ID', err);}

        for (const item of data.items) {
            if (item.name === integrationName) {
                console.log(`restApi ID ${item.id}`);
                cb(item.id);
                return
            }
        }
        console.assert(false, 'Could not find any integrations. Ensure you have deployed engagement edge.')
    });
};

class EngagementUx extends cdk.Stack {
    constructor(parent: cdk.App,
                id: string,
                edge: EngagementEdge,
    ) {
        super(parent, id + '-stack');
        const bucketName = process.env.BUCKET_PREFIX + id + '-bucket';

        const edgeBucket = new s3.Bucket(this, bucketName, {
            bucketName,
            publicReadAccess: true,
            websiteIndexDocument: 'index.html',
        });

        const _this = this;
        getEdgeGatewayId(
            edge.name + 'Integration',
            (gatewayId) => {
                const edgeUrl = `https://${gatewayId}.execute-api.${AWS.config.region}.amazonaws.com/prod/`;

                const filesToModify = [path.join(__dirname, 'edge_ux/index.js'), path.join(__dirname, 'edge_ux/lens.js')];
                const toReplace = 'const engagement_edge = "";';
                const replacement = `const engagement_edge = "${edgeUrl}";`;

                for (const toModify of filesToModify) {
                    replaceInFile(toModify, toReplace, replacement)
                }
                console.log(path.join(__dirname, 'edge_ux/'));
                new s3deploy.BucketDeployment(_this, id + 'Ux', {
                    source: s3deploy.Source.asset('./edge_ux'),
                    destinationBucket: edgeBucket,
                    destinationKeyPrefix: 'web/static'
                });
        });
    }
}

class HistoryDb extends cdk.Stack {

    proc_history: dynamodb.Table;
    file_history: dynamodb.Table;
    outbound_connection_history: dynamodb.Table;
    asset_history: dynamodb.Table;
    node_id_retry_table: dynamodb.Table;

    dynamic_session_table: dynamodb.Table;
    static_mapping_table: dynamodb.Table;

    constructor(parent: cdk.App,
                id: string,
    ) {
        super(parent, id + '-stack');

        this.proc_history = new dynamodb.Table(this, 'process_history_table', {
            tableName: "process_history_table",
            partitionKey: {
                name: 'pseudo_key',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {
                name: 'create_time',
                type: dynamodb.AttributeType.NUMBER
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        this.file_history = new dynamodb.Table(this, 'file_history_table', {
            tableName: "file_history_table",
            partitionKey: {
                name: 'pseudo_key',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {
                name: 'create_time',
                type: dynamodb.AttributeType.NUMBER
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        this.outbound_connection_history = new dynamodb.Table(this, 'outbound_connection_history_table', {
            tableName: "outbound_connection_history_table",
            partitionKey: {
                name: 'pseudo_key',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {
                name: 'create_time',
                type: dynamodb.AttributeType.NUMBER
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        this.asset_history = new dynamodb.Table(this, 'asset_id_mappings', {
            tableName: "asset_id_mappings",
            partitionKey: {
                name: 'pseudo_key',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {
                name: 'c_timestamp',
                type: dynamodb.AttributeType.NUMBER
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });


        this.dynamic_session_table = new dynamodb.Table(this, 'dynamic_session_table', {
            tableName: "dynamic_session_table",
            partitionKey: {
                name: 'pseudo_key',
                type: dynamodb.AttributeType.STRING
            },
            sortKey: {
                name: 'create_time',
                type: dynamodb.AttributeType.NUMBER
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });


        this.static_mapping_table = new dynamodb.Table(this, 'static_mapping_table', {
            tableName: "static_mapping_table",
            partitionKey: {
                name: 'pseudo_key',
                type: dynamodb.AttributeType.STRING
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        });

        this.node_id_retry_table = new dynamodb.Table(this, 'node_id_retry_table', {
            tableName: "node_id_retry_table",
            partitionKey: {
                name: 'pseudo_key',
                type: dynamodb.AttributeType.STRING
            },
            billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
            timeToLiveAttribute: "ttl_ts"
        });

    }

    allowReadWrite(service: Service) {
        this.proc_history.grantReadWriteData(service.event_handler.role);
        this.file_history.grantReadWriteData(service.event_handler.role);
        this.outbound_connection_history.grantReadWriteData(service.event_handler.role);
        this.asset_history.grantReadWriteData(service.event_handler.role);
        this.node_id_retry_table.grantReadWriteData(service.event_handler.role);
        this.static_mapping_table.grantReadWriteData(service.event_handler.role);
        this.dynamic_session_table.grantReadWriteData(service.event_handler.role);

        this.proc_history.grantReadWriteData(service.event_retry_handler.role);
        this.file_history.grantReadWriteData(service.event_retry_handler.role);
        this.outbound_connection_history.grantReadWriteData(service.event_retry_handler.role);
        this.asset_history.grantReadWriteData(service.event_retry_handler.role);
        this.node_id_retry_table.grantReadWriteData(service.event_retry_handler.role);
        this.static_mapping_table.grantReadWriteData(service.event_retry_handler.role);
        this.dynamic_session_table.grantReadWriteData(service.event_retry_handler.role);
    }
}

class Grapl extends cdk.App {
    constructor() {
        super();

        env(__dirname + '/.env');

        const mgZeroCount = Number(process.env.MG_ZEROS_COUNT) || 3;
        const mgAlphaCount = Number(process.env.MG_ALPHAS_COUNT) || 5;
        const egZeroCount = Number(process.env.EG_ZEROS_COUNT) || 3;
        const egAlphaCount = Number(process.env.EG_ALPHAS_COUNT) || 5;

        let event_emitters = new EventEmitters(this, 'grapl-event-emitters');

        const network = new Networks(this, 'graplvpcs');

        const history_db = new HistoryDb(
            this,
            'graplhistorydb',
        );

        const master_graph = new DGraphFargate(
            this,
            'mastergraphcluster',
            network.grapl_vpc,
            mgZeroCount,
            mgAlphaCount,
        );

        const engagement_graph = new DGraphFargate(
            this,
            'engagementgraphcluster',
            network.grapl_vpc,
            egZeroCount,
            egAlphaCount,
        );

        new GenericSubgraphGenerator(
            this,
            'grapl-generic-subgraph-generator',
            event_emitters.raw_logs_bucket,
            event_emitters.raw_logs_topic,
            event_emitters.unid_subgraphs_generated_bucket
        );

        new SysmonSubgraphGenerator(
            this,
            'grapl-sysmon-subgraph-generator',
            event_emitters.sysmon_logs_bucket,
            event_emitters.sysmon_logs_topic,
            event_emitters.unid_subgraphs_generated_bucket
        );


        new NodeIdentityMapper(
            this,
            'grapl-node-identity-mapper',
            event_emitters.identity_mappings_bucket,
            event_emitters.identity_mappings_topic,
            network.grapl_vpc
        );

        new NodeIdentifier(
            this,
            'grapl-node-identifier',
            event_emitters.unid_subgraphs_generated_bucket,
            event_emitters.unid_subgraphs_generated_topic,
            event_emitters.subgraphs_generated_bucket,
            history_db,
            network.grapl_vpc
        );

        new GraphMerger(
            this,
            'grapl-graph-merger',
            event_emitters.subgraphs_generated_bucket,
            event_emitters.subgraphs_generated_topic,
            event_emitters.subgraph_merged_topic,
            master_graph,
            network.grapl_vpc
        );

        new AnalyzerDispatch(
            this,
            'grapl-analyzer-dispatcher',
            event_emitters.subgraph_merged_topic,
            event_emitters.dispatched_analyzer_bucket,
            event_emitters.analyzers_bucket,
            network.grapl_vpc
        );

        new AnalyzerExecutor(
            this,
            'grapl-analyzer-executor',
            event_emitters.dispatched_analyzer_topic,
            event_emitters.analyzers_bucket,
            event_emitters.dispatched_analyzer_bucket,
            event_emitters.analyzer_matched_subgraphs_bucket,
            master_graph,
            network.grapl_vpc
        );

        new EngagementCreator(
            this,
            'grapl-engagement-creator',
            event_emitters.analyzer_matched_subgraphs_bucket,
            event_emitters.analyzer_matched_subgraphs_topic,
            event_emitters.engagements_created_topic,
            master_graph,
            engagement_graph,
            network.grapl_vpc
        );

        const engagement_edge = new EngagementEdge(
            this,
            'engagementedge' + process.env.BUCKET_PREFIX,
            'engagementedge' + process.env.BUCKET_PREFIX,
            engagement_graph,
            network.grapl_vpc
        );

        new EngagementNotebook(
            this,
            'engagements',
            network.grapl_vpc
        );

        new EngagementUx(
            this,
            'engagement-ux',
            engagement_edge
        );
    }
}

new Grapl().synth();

// cdk deploy graplvpcs-stack && \
// cdk deploy graplhistorydb-stack && \
// cdk deploy grapl-event-emitters-stack && \
// cdk deploy graplmastergraph-stack && \
// cdk deploy graplengagementgraph-stack && \
// cdk deploy grapl-generic-subgraph-generator-stack && \
// cdk deploy grapl-sysmon-subgraph-generator-stack && \
// cdk deploy grapl-node-identity-mapper-stack && \
// cdk deploy grapl-node-identifier-stack && \
// cdk deploy grapl-graph-merger-stack && \
// cdk deploy grapl-analyzer-dispatcher-stack && \
// cdk deploy grapl-analyzer-executor-stack && \
// cdk deploy grapl-engagement-creator-stack
