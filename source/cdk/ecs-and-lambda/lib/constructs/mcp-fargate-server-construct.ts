import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as path from "path";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as logs from "aws-cdk-lib/aws-logs";
import { NagSuppressions } from "cdk-nag";

export interface McpFargateServerConstructProps {
  /**
   * The shared platform components
   */
  platform: {
    vpc: ec2.IVpc;
    cluster: ecs.Cluster;
  };

  /**
   * The name of the MCP server
   */
  serverName: string;

  /**
   * The path to the server implementation
   */
  serverPath: string;

  /**
   * The port that the container listens on
   * @default 8080
   */
  containerPort?: number;

  /**
   * The health check path
   * @default /health
   */
  healthCheckPath?: string;

  /**
   * Environment variables for the container
   */
  environment?: Record<string, string>;

  /**
   * Secret environment variables for the container
   */
  secrets?: Record<string, ecs.Secret>;

  /**
   * Memory limit for the Fargate task
   * @default 512
   */
  memoryLimitMiB?: number;

  /**
   * CPU units for the Fargate task
   * @default 256
   */
  cpuUnits?: number;

  /**
   * Container count for the Fargate service
   * @default 2
   */
  desiredCount?: number;

  /**
   * Auto-scaling config for minimum capacity
   * @default 1
   */
  minCapacity?: number;

  /**
   * Auto-scaling config for maximum capacity
   * @default 5
   */
  maxCapacity?: number;

  /**
   * EC2 security group for application load balancer
   */
  albSecurityGroup: ec2.SecurityGroup;

  urlParameterName: string;
}

export class McpFargateServerConstruct extends Construct {
  public readonly fargateService: ecs.FargateService;
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  constructor(
    scope: Construct,
    id: string,
    props: McpFargateServerConstructProps
  ) {
    super(scope, id);

    // Set defaults
    const serverName = props.serverName;
    const containerPort = props.containerPort || 8080;
    const healthCheckPath = props.healthCheckPath || "/health";
    const memoryLimitMiB = props.memoryLimitMiB || 512;
    const cpuUnits = props.cpuUnits || 256;
    const desiredCount = props.desiredCount || 2;
    const minCapacity = props.minCapacity || 1;
    const maxCapacity = props.maxCapacity || 5;
    const albSecurityGroup = props.albSecurityGroup;

    // Create Docker image asset with platform specification for cross-architecture compatibility
    const dockerImage = new ecr_assets.DockerImageAsset(
      this,
      `${serverName}Image`,
      {
        // Sanitize the path to prevent path traversal attacks
        directory: path.resolve(props.serverPath.replace(/\.\./g, "")),
        platform: ecr_assets.Platform.LINUX_AMD64, // Explicitly build for x86 Linux
        buildArgs: {
          // Build arguments if needed
        },
      }
    );

    // Use the shared cluster from the platform
    const cluster = props.platform.cluster;

    // Create task definition
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      `${serverName}Task`,
      {
        memoryLimitMiB,
        cpu: cpuUnits,
      }
    );

    // Add permissions to the task role to read SSM parameters
    taskDefinition.taskRole.addToPrincipalPolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          `arn:aws:ssm:${cdk.Stack.of(this).region}:${
            cdk.Stack.of(this).account
          }:parameter/mcp/*`,
        ],
        effect: cdk.aws_iam.Effect.ALLOW,
      })
    );

    // Create log group for container
    const logGroup = new logs.LogGroup(this, `${serverName}Logs`, {
      logGroupName: `/ecs/mcp-${serverName.toLowerCase()}-server`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Add container to task definition
    const container = taskDefinition.addContainer(`${serverName}Container`, {
      image: ecs.ContainerImage.fromDockerImageAsset(dockerImage),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `mcp-${serverName.toLowerCase()}`,
        logGroup,
      }),
      healthCheck: {
        command: [
          "CMD-SHELL",
          `curl -f http://localhost:${containerPort}${healthCheckPath} || exit 1`,
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      environment: {
        ...props.environment,
      },
      secrets: props.secrets || {},
    });

    // Map container port
    container.addPortMappings({
      containerPort,
      hostPort: containerPort,
      protocol: ecs.Protocol.TCP,
    });

    // Create security group for the Fargate service
    const serviceSecurityGroup = new ec2.SecurityGroup(
      this,
      `${serverName}ServiceSecurityGroup`,
      {
        vpc: props.platform.vpc,
        allowAllOutbound: true,
        description: `Security group for ${serverName} MCP server service`,
      }
    );

    // Allow inbound traffic from ALB
    serviceSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(albSecurityGroup.securityGroupId),
      ec2.Port.tcp(containerPort),
      `Allow traffic from ${serverName} ALB to container`
    );

    // Create Fargate service
    this.fargateService = new ecs.FargateService(this, `${serverName}Service`, {
      cluster,
      taskDefinition,
      desiredCount,
      securityGroups: [serviceSecurityGroup],
      assignPublicIp: false,
      minHealthyPercent: 50,
      maxHealthyPercent: 100,
    });

    // Enable auto-scaling
    const scaling = this.fargateService.autoScaleTaskCount({
      minCapacity,
      maxCapacity,
    });

    scaling.scaleOnCpuUtilization(`${serverName}CpuScaling`, {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // Create target group with a unique name
    this.targetGroup = new elbv2.ApplicationTargetGroup(
      this,
      `${serverName}TargetGroup`,
      {
        vpc: props.platform.vpc,
        port: containerPort,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        targetGroupName: `${id}-${serverName}-tg`
          .substring(0, 32)
          .toLowerCase(),
        healthCheck: {
          path: healthCheckPath,
          port: containerPort.toString(),
          interval: cdk.Duration.seconds(30),
          timeout: cdk.Duration.seconds(5),
          healthyThresholdCount: 3,
          unhealthyThresholdCount: 3,
        },
      }
    );

    // Register targets
    this.targetGroup.addTarget(this.fargateService);

    // Add suppressions for IAM wildcards
    NagSuppressions.addResourceSuppressions(
      taskDefinition,
      [
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Task role needs access to MCP-related SSM parameters using consistent prefix pattern",
          appliesTo: [
            `Resource::arn:aws:ssm:${cdk.Stack.of(this).region}:${
              cdk.Stack.of(this).account
            }:parameter/mcp/*`,
          ],
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "ECS task execution role requires ECR, CloudWatch Logs, and Secrets Manager access",
          appliesTo: ["Resource::*"],
        },
        {
          id: "AwsSolutions-ECS2",
          reason:
            "Environment variables contain non-sensitive configuration values only - sensitive values are passed via Secrets Manager",
        },
      ],
      true // Apply to child constructs including task and execution roles
    );

    // Update the container's environment to include the parameter name
    container.addEnvironment(
      "MCP_SERVER_BASE_URL_PARAMETER_NAME",
      props.urlParameterName
    );
  }
}
