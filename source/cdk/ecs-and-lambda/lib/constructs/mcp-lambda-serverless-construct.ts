import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as ec2 from "aws-cdk-lib/aws-ec2";

export interface McpLambdaServerlessConstructProps {
  /**
   * VPC where the Lambda is deployed
   */
  vpc: ec2.IVpc;

  /**
   * The Lambda function to use
   */
  function: lambda.IFunction;

  /**
   * Path for ALB health checks
   * @default /weather-nodejs/mcp
   */
  healthCheckPath?: string;
}

export class McpLambdaServerlessConstruct extends Construct {
  public readonly targetGroup: elbv2.ApplicationTargetGroup;

  constructor(
    scope: Construct,
    id: string,
    props: McpLambdaServerlessConstructProps
  ) {
    super(scope, id);

    // Create target group
    this.targetGroup = new elbv2.ApplicationTargetGroup(this, "TargetGroup", {
      vpc: props.vpc,
      targetType: elbv2.TargetType.LAMBDA,
      targets: [new targets.LambdaTarget(props.function)],
    });

    // Grant invoke permissions from ALB
    props.function.addPermission("AllowALBInvoke", {
      principal: new cdk.aws_iam.ServicePrincipal(
        "elasticloadbalancing.amazonaws.com"
      ),
      sourceArn: this.targetGroup.targetGroupArn,
    });
  }
}
