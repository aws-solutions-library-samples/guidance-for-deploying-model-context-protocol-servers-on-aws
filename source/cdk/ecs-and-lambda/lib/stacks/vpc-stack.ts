import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";

export interface VpcStackProps extends cdk.StackProps {
  /**
   * Optional existing VPC ID to use instead of creating a new VPC
   */
  existingVpcId?: string;

  /**
   * Optional existing public subnet IDs when using an existing VPC
   */
  publicSubnetIds?: string[];

  /**
   * Optional existing private subnet IDs when using an existing VPC
   */
  privateSubnetIds?: string[];
}

export class VpcStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;

  constructor(scope: Construct, id: string, props?: VpcStackProps) {
    super(scope, id, props);

    if (props?.existingVpcId) {
      // Use existing VPC
      this.vpc = ec2.Vpc.fromVpcAttributes(this, "ImportedVpc", {
        vpcId: props.existingVpcId,
        publicSubnetIds: props.publicSubnetIds || [],
        privateSubnetIds: props.privateSubnetIds || [],
        availabilityZones: cdk.Stack.of(this).availabilityZones,
      });

      // Output information about the imported VPC
      new cdk.CfnOutput(this, "VpcId", {
        value: this.vpc.vpcId,
        description: "The ID of the imported VPC",
      });
    } else {
      // Create new VPC
      this.vpc = new ec2.Vpc(this, "MCP-VPC", {
        maxAzs: 2,
        natGateways: 1,
        subnetConfiguration: [
          {
            cidrMask: 24,
            name: "public",
            subnetType: ec2.SubnetType.PUBLIC,
            mapPublicIpOnLaunch: false, // Disable auto-assignment of public IPs
          },
          {
            cidrMask: 24,
            name: "private",
            subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          },
        ],
      });

      // Output information about the created VPC
      new cdk.CfnOutput(this, "VpcId", {
        value: this.vpc.vpcId,
        description: "The ID of the created VPC",
      });
    }

    this.vpc.addFlowLog("VpcFlowLog", {
      trafficType: ec2.FlowLogTrafficType.ALL,
      destination: ec2.FlowLogDestination.toCloudWatchLogs(),
    });
  }
}
