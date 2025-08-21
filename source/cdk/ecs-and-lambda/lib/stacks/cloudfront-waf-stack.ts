import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { NagSuppressions } from "cdk-nag";

export interface CloudFrontWafStackProps extends cdk.StackProps {
  /**
   * Resource suffix for unique naming
   */
  resourceSuffix: string;

  /**
   * Target region where the main stack is deployed
   */
  targetRegion: string;
}

/**
 * Stack that creates a CloudFront-scoped WAF Web ACL
 * This stack must be deployed in us-east-1 region
 */
export class CloudFrontWafStack extends cdk.Stack {
  public readonly webAcl: wafv2.CfnWebACL;
  public readonly webAclArn: string;
  public readonly webAclId: string;

  constructor(scope: Construct, id: string, props: CloudFrontWafStackProps) {
    super(scope, id, props);

    // Verify we're in us-east-1 since CloudFront WAF must be in that region
    if (this.region !== "us-east-1") {
      throw new Error(
        "CloudFrontWafStack must be deployed in us-east-1 region only"
      );
    }

    // Create WAF Web ACL for CloudFront (global scope)
    this.webAcl = new wafv2.CfnWebACL(this, "MCPCloudFrontWAF", {
      name: `mcp-cloudfront-waf-${props.resourceSuffix}`,
      defaultAction: { allow: {} },
      scope: "CLOUDFRONT", // Must be CLOUDFRONT for CloudFront distributions
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "MCPCloudFrontWAF",
        sampledRequestsEnabled: true,
      },
      rules: [
        // Allow rule for OAuth endpoints
        {
          name: "AllowOAuthEndpoints",
          priority: 1, // Highest priority
          statement: {
            orStatement: {
              statements: [
                // /register endpoint
                {
                  byteMatchStatement: {
                    fieldToMatch: {
                      uriPath: {},
                    },
                    positionalConstraint: "EXACTLY",
                    searchString: "/register",
                    textTransformations: [
                      {
                        priority: 0,
                        type: "NONE",
                      },
                    ],
                  },
                },
                // /authorize endpoint
                {
                  byteMatchStatement: {
                    fieldToMatch: {
                      uriPath: {},
                    },
                    positionalConstraint: "EXACTLY",
                    searchString: "/authorize",
                    textTransformations: [
                      {
                        priority: 0,
                        type: "NONE",
                      },
                    ],
                  },
                },
                // /token endpoint
                {
                  byteMatchStatement: {
                    fieldToMatch: {
                      uriPath: {},
                    },
                    positionalConstraint: "EXACTLY",
                    searchString: "/token",
                    textTransformations: [
                      {
                        priority: 0,
                        type: "NONE",
                      },
                    ],
                  },
                },
              ],
            },
          },
          action: { allow: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AllowOAuthEndpoints",
            sampledRequestsEnabled: true,
          },
        },
        // AWS Managed Rules - Core rule set
        {
          name: "AWS-AWSManagedRulesCommonRuleSet",
          priority: 10,
          statement: {
            managedRuleGroupStatement: {
              name: "AWSManagedRulesCommonRuleSet",
              vendorName: "AWS",
              excludedRules: [
                // Rules that commonly affect SSE connections
                { name: "NoUserAgent_HEADER" },
                { name: "UserAgent_BadBots_HEADER" },
              ],
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "AWS-AWSManagedRulesCommonRuleSet",
            sampledRequestsEnabled: true,
          },
        },
        // Rate-based rule to prevent DDoS
        {
          name: "RateLimitRule",
          priority: 20,
          statement: {
            rateBasedStatement: {
              limit: 3000, // Increased from 1000 to accommodate SSE connections
              aggregateKeyType: "IP",
            },
          },
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "RateLimitRule",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Store the WebACL ARN and ID
    this.webAclArn = this.webAcl.attrArn;
    this.webAclId = this.webAcl.ref;

    // Store the CloudFront WAF ARN in local SSM Parameter Store
    const paramName = `/mcp/cloudfront-waf-arn-${props.resourceSuffix}`;
    new ssm.StringParameter(this, "CloudFrontWafArnParameter", {
      parameterName: paramName,
      description: "ARN of the CloudFront WAF Web ACL",
      stringValue: this.webAclArn,
    });

    // Output the WAF ARN
    new cdk.CfnOutput(this, "CloudFrontWafArn", {
      value: this.webAclArn,
      description: "ARN of the CloudFront WAF Web ACL",
      exportName: `CloudFrontWafArn-${props.resourceSuffix}`,
    });

    // Output the param name
    new cdk.CfnOutput(this, "CloudFrontWafArnParamName", {
      value: paramName,
      description: "SSM Parameter name storing the CloudFront WAF ARN",
    });

    // Create a Lambda function to sync the WAF ID to the target region
    const crossRegionSyncFunction = new cdk.aws_lambda.Function(
      this,
      "CrossRegionWafSyncFunction",
      {
        functionName: `cloudfront-waf-sync-${props.resourceSuffix}`,
        runtime: cdk.aws_lambda.Runtime.NODEJS_22_X,
        handler: "index.handler",
        code: cdk.aws_lambda.Code.fromInline(`
const https = require('https');
const url = require('url');

// AWS SDK v3 is available in the Lambda runtime
const { SSMClient, PutParameterCommand } = require('@aws-sdk/client-ssm');

exports.handler = async function(event, context) {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  try {
    // For CREATE and UPDATE events, we need to sync the parameter
    if (event.RequestType === 'Create' || event.RequestType === 'Update') {
      const props = event.ResourceProperties;
      const webAclId = props.WebAclId;
      const webAclArn = props.WebAclArn;
      const parameterName = props.ParameterName;
      const targetRegion = props.TargetRegion;
      
      console.log('WebACL ID:', webAclId);
      console.log('WebACL ARN:', webAclArn);
      console.log('Parameter Name:', parameterName);
      console.log('Target Region:', targetRegion);
      
      // Update the SSM parameter in the target region
      const ssmClient = new SSMClient({ region: targetRegion });
      const putParameterCommand = new PutParameterCommand({
        Name: parameterName,
        Value: webAclArn, // Just store the ARN directly
        Type: 'String',
        Overwrite: true
      });
      
      await ssmClient.send(putParameterCommand);
      console.log('Parameter updated successfully in region', targetRegion);
    }
    
    // Send success response back to CloudFormation
    await sendResponse(event, context, 'SUCCESS', { Message: 'Operation completed successfully' });
  } catch (error) {
    console.error('Error:', error);
    await sendResponse(event, context, 'FAILED', { Error: error.message });
  }
};

// Helper function to send response to CloudFormation
async function sendResponse(event, context, responseStatus, responseData) {
  const responseBody = JSON.stringify({
    Status: responseStatus,
    Reason: responseStatus === 'FAILED' ? 'See the details in CloudWatch Log Stream: ' + context.logStreamName : 'See the details in CloudWatch Log Stream',
    PhysicalResourceId: context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: false,
    Data: responseData
  });
  
  console.log('Response body:', responseBody);
  
  const parsedUrl = url.parse(event.ResponseURL);
  
  const options = {
    hostname: parsedUrl.hostname,
    port: 443,
    path: parsedUrl.path,
    method: 'PUT',
    headers: {
      'Content-Type': '',
      'Content-Length': responseBody.length
    }
  };
  
  return new Promise((resolve, reject) => {
    const request = https.request(options, function(response) {
      console.log('Status code:', response.statusCode);
      resolve();
    });
    
    request.on('error', function(error) {
      console.log('send response error:', error);
      reject(error);
    });
    
    request.write(responseBody);
    request.end();
  });
}
        `),
        timeout: cdk.Duration.seconds(30),
      }
    );

    // Grant permission to write SSM parameter in the target region
    crossRegionSyncFunction.addToRolePolicy(
      new cdk.aws_iam.PolicyStatement({
        actions: ["ssm:PutParameter"],
        resources: [
          `arn:aws:ssm:${props.targetRegion}:${cdk.Aws.ACCOUNT_ID}:parameter/mcp/cloudfront-waf-*`,
        ],
      })
    );

    // Create a custom resource that uses the Lambda function
    new cdk.CustomResource(this, "CrossRegionWafSync", {
      serviceToken: crossRegionSyncFunction.functionArn,
      properties: {
        // Adding a timestamp forces the custom resource to run on each deployment
        Timestamp: Date.now().toString(),
        WebAclId: this.webAclId,
        WebAclArn: this.webAclArn,
        ParameterName: `/mcp/cloudfront-waf-arn-${props.resourceSuffix}`,
        TargetRegion: props.targetRegion,
      },
    });

    NagSuppressions.addResourceSuppressions(
      crossRegionSyncFunction,
      [
        {
          id: "AwsSolutions-IAM4",
          reason:
            "Lambda function used by CloudFront WAF cross-region sync custom resource requires CloudWatch logs access",
          appliesTo: [
            "Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
          ],
        },
        {
          id: "AwsSolutions-IAM5",
          reason:
            "Lambda function used by CloudFront WAF cross-region sync custom resource requires access to SSM parameters using consistent prefix for WAF ARN storage",
          appliesTo: [
            `Resource::arn:aws:ssm:${props.targetRegion}:<AWS::AccountId>:parameter/mcp/cloudfront-waf-*`,
          ],
        },
      ],
      true // Apply to child constructs
    );
  }
}
