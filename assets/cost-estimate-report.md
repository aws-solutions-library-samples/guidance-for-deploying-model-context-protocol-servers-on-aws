# AWS MCP Server Infrastructure Cost Analysis Estimate Report

## Service Overview

AWS MCP Server Infrastructure is a fully managed solution for deploying Model Context Protocol servers using multiple AWS services. This project uses AWS ECS Fargate, Lambda, Cognito, CloudFront, and other AWS services to provide a scalable, secure MCP server deployment. This service follows a pay-as-you-go pricing model, making it cost-effective for various workloads.

## Pricing Model

This cost analysis estimate is based on the following pricing model:

- **ON DEMAND** pricing (pay-as-you-go) unless otherwise specified
- Standard service configurations without reserved capacity or savings plans
- No caching or optimization techniques applied

## Assumptions

- Average monthly usage with moderate traffic
- Deployment region is us-east-1
- Single MCP server deployed with Python sample weather implementation
- Moderate user authentication traffic through Cognito
- 1 TB monthly data transfer for CloudFront
- DynamoDB is used for token storage with on-demand capacity mode
- Two Availability Zones are used as configured in VPC stack
- NAT Gateway deployed for private subnet connectivity

## Limitations and Exclusions

- Custom domain and SSL certificate costs (optional in the stack)
- Data transfer between regions
- Development and maintenance costs
- Reserved capacity costs that might reduce pricing if committed
- Optional MCP server implementations beyond the sample weather server

## Cost Breakdown

### Unit Pricing Details

_Pricing verified as of August 2025 for us-east-1 region using AWS Pricing API via MCP server_

| Service                | Resource Type               | Unit                             | Price         | Free Tier                                                                                            |
| ---------------------- | --------------------------- | -------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| VPC                    | Nat Gateway                 | hour                             | $0.045        | No free tier for NAT Gateway                                                                         |
| VPC                    | Nat Gateway Data Processing | GB                               | $0.045        | No free tier for NAT Gateway                                                                         |
| Elastic Load Balancing | Load Balancer Hours         | hour                             | $0.0225       | No free tier for ALB                                                                                 |
| Elastic Load Balancing | Lcu                         | LCU-hour                         | $0.008        | No free tier for ALB                                                                                 |
| Amazon Cognito         | Mau Essentials              | MAU after free tier              | $0.0055       | First 50,000 MAUs are free with Essentials tier                                                      |
| CloudFront             | Data Transfer               | GB after first TB                | $0.085        | First 1 TB data transfer is free                                                                     |
| CloudFront             | Https Requests              | 10,000 requests after first 10M  | $0.01         | First 10M HTTPS requests free per month, first 1 TB data transfer is free                            |
| WAF                    | Web Acl                     | Web ACL per month                | $5.00         | No free tier for WAF                                                                                 |
| WAF                    | Rule Evaluations            | million rule evaluations         | $0.60         | No free tier for WAF                                                                                 |
| DynamoDB               | Storage                     | GB-month after free tier         | $0.25         | 25 GB storage and limited read/write capacity included in free tier                                  |
| DynamoDB               | Read Request Units          | million RRUs (on-demand mode)    | $0.25         | 25 GB storage and limited read/write capacity included in free tier                                  |
| DynamoDB               | Write Request Units         | million WRUs (on-demand mode)    | $1.25         | 25 GB storage and limited read/write capacity included in free tier                                  |
| ECS                    | Fargate Vcpu                | vCPU-hour                        | $0.04048      | No free tier specific to ECS, but underlying EC2 or Fargate resources may have free tier eligibility |
| ECS                    | Fargate Memory              | GB-hour                          | $0.004445     | No free tier specific to ECS, but underlying EC2 or Fargate resources may have free tier eligibility |
| Secrets Manager        | Secrets                     | secret per month                 | $0.40         | No free tier for Secrets Manager                                                                     |
| Secrets Manager        | Api Calls                   | 10,000 API calls                 | $0.05         | No free tier for Secrets Manager                                                                     |
| Lambda                 | Requests                    | million requests after free tier | $0.20         | 1M free requests per month and 400,000 GB-seconds of compute time                                    |
| Lambda                 | Duration                    | GB-second after free tier        | $0.0000166667 | 1M free requests per month and 400,000 GB-seconds of compute time                                    |

### Cost Calculation

| Service                | Usage                                                                                                                                            | Calculation                                                                                       | Monthly Cost      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------- |
| VPC                    | 2 Availability Zones with public and private subnets, 1 NAT Gateway (Nat Gateway: 1 NAT Gateway × 730 hours, Data Processed: 100 GB (estimated)) | $0.045/hr × 730 hours = $32.85 for NAT Gateway + $0.045/GB × 100 GB = $4.50 for data processing   | $37.35            |
| Elastic Load Balancing | Application Load Balancer for MCP Server (Load Balancer Hours: 730 hours, Lcu: 50 LCUs (estimated average for moderate traffic))                 | $0.0225/hr × 730 hours = $16.43 + $0.008/LCU × 50 LCU × 730 hours / 730 = $16.43 + $0.40 = $16.83 | $16.83            |
| Amazon Cognito         | User authentication for MCP Server (Mau Essentials: 10,500 MAUs (estimated))                                                                     | 10,500 MAUs under 50,000 free tier limit = $0.00                                                  | $0.00             |
| CloudFront             | Content delivery for MCP server frontend (Data Transfer: 2 TB (2,000 GB), Https Requests: 15 million)                                            | $0.085/GB × (2,000 GB - 1,024 GB) = $0.085 × 976 = $82.96 + $0.01/10k × (15M - 10M)/10k = $5.00   | $87.96            |
| WAF                    | Web Application Firewall for both CloudFront and regional protection (Web Acl: 2 Web ACLs (CloudFront and Regional))                             | $5.00 × 2 Web ACLs = $10.00                                                                       | $10.00            |
| DynamoDB               | Token storage for MCP server (Storage: 1 GB, Read Request Units: 5 million, Write Request Units: 3 million)                                      | Storage covered by free tier, $0.25/M × (5M - free tier) + $1.25/M × (3M - free tier) ≈ $5.40     | $5.40             |
| ECS                    | Container service for MCP server (Fargate Vcpu: 1 vCPU × 730 hours, Fargate Memory: 2 GB × 730 hours)                                            | $0.04048 × 1 × 730 + $0.004445 × 2 × 730 = $29.55 + $6.49 = $36.04                                | $36.04            |
| Secrets Manager        | Managing Cognito client secrets (Secrets: 1 secret, Api Calls: minimal, under 10,000)                                                            | $0.40 × 1 secret = $0.40                                                                          | $0.40             |
| Lambda                 | Custom resources for configuration (Requests: minimal, under free tier, Duration: minimal, under free tier)                                      | Likely covered by free tier, estimated minimal usage cost of $0.20                                | $0.20             |
| **Total**              | **All services**                                                                                                                                 | **Sum of all calculations**                                                                       | **$194.18/month** |

### Free Tier

Free tier information by service:

- **VPC**: No free tier for NAT Gateway
- **Elastic Load Balancing**: No free tier for ALB
- **Amazon Cognito**: First 50,000 MAUs are free with Essentials tier
- **CloudFront**: First 1 TB data transfer is free
- **WAF**: No free tier for WAF
- **DynamoDB**: 25 GB storage and limited read/write capacity included in free tier
- **ECS**: No free tier specific to ECS, but underlying EC2 or Fargate resources may have free tier eligibility
- **Secrets Manager**: No free tier for Secrets Manager
- **Lambda**: 1M free requests per month and 400,000 GB-seconds of compute time

## Cost Scaling with Usage

The following table illustrates how cost estimates scale with different usage levels:

| Service                | Low Usage | Medium Usage | High Usage |
| ---------------------- | --------- | ------------ | ---------- |
| VPC                    | $18/month | $37/month    | $75/month  |
| Elastic Load Balancing | $10/month | $17/month    | $35/month  |
| Amazon Cognito         | $0/month  | $0/month     | $3/month   |
| CloudFront             | $45/month | $88/month    | $175/month |
| WAF                    | $5/month  | $10/month    | $20/month  |
| DynamoDB               | $2/month  | $5/month     | $12/month  |
| ECS                    | $18/month | $36/month    | $72/month  |
| Secrets Manager        | $0/month  | $0/month     | $1/month   |
| Lambda                 | $0/month  | $0/month     | $0/month   |

### Key Cost Factors

- **VPC**: 2 Availability Zones with public and private subnets, 1 NAT Gateway
- **Elastic Load Balancing**: Application Load Balancer for MCP Server
- **Amazon Cognito**: User authentication for MCP Server
- **CloudFront**: Content delivery for MCP server frontend
- **WAF**: Web Application Firewall for both CloudFront and regional protection
- **DynamoDB**: Token storage for MCP server
- **ECS**: Container service for MCP server
- **Secrets Manager**: Managing Cognito client secrets
- **Lambda**: Custom resources for configuration

## Projected Costs Over Time

The following projections show estimated monthly costs over a 12-month period based on different growth patterns:

Base monthly cost calculation:

| Service                | Monthly Cost |
| ---------------------- | ------------ |
| VPC                    | $37.35       |
| Elastic Load Balancing | $16.83       |
| Amazon Cognito         | $0.00        |
| CloudFront             | $87.96       |
| WAF                    | $10.00       |
| DynamoDB               | $5.40        |
| ECS                    | $36.04       |
| Secrets Manager        | $0.40        |
| Lambda                 | $0.20        |
| **Total Monthly Cost** | **$194**     |

| Growth Pattern | Month 1 | Month 3 | Month 6 | Month 12 |
| -------------- | ------- | ------- | ------- | -------- |
| Steady         | $194/mo | $194/mo | $194/mo | $194/mo  |
| Moderate       | $194/mo | $214/mo | $248/mo | $333/mo  |
| Rapid          | $194/mo | $235/mo | $314/mo | $558/mo  |

- Steady: No monthly growth (1.0x)
- Moderate: 5% monthly growth (1.05x)
- Rapid: 10% monthly growth (1.1x)

## Detailed Cost Analysis

### Pricing Model

ON DEMAND

### Exclusions

- Custom domain and SSL certificate costs (optional in the stack)
- Data transfer between regions
- Development and maintenance costs
- Reserved capacity costs that might reduce pricing if committed
- Optional MCP server implementations beyond the sample weather server

### Recommendations

#### Immediate Actions

- Monitor Cognito MAU usage to stay within free tier limits
- Consider using reserved capacity for predictable ECS workloads
- Evaluate if you need a NAT Gateway in both availability zones or if one is sufficient

#### Best Practices

- Use CloudWatch to monitor resource utilization and adjust capacity as needed
- Consider Reserved Instances for long-term ECS usage to reduce costs
- Set up AWS Budgets to alert on unexpected cost increases
- Implement lifecycle policies for DynamoDB token table to automatically expire old tokens

## Cost Optimization Recommendations

### Immediate Actions

- Take advantage of Cognito's increased free tier (50,000 MAUs vs previous 10,000)
- Monitor usage patterns and consider reserved capacity for predictable workloads
- Evaluate optimal CloudFront data transfer patterns

### Best Practices

- Use CloudWatch to monitor resource utilization and adjust capacity as needed
- Consider Reserved Instances for long-term ECS usage to reduce costs
- Set up AWS Budgets to alert on unexpected cost increases

## Conclusion

The updated cost analysis shows a total estimated monthly cost of $194.18, with the main cost drivers being CloudFront ($87.96), VPC NAT Gateway ($37.35), and ECS Fargate ($36.04). The Cognito free tier increase to 50,000 MAUs provides significant cost savings for moderate usage scenarios. By following the recommendations in this report, you can optimize your AWS MCP Server Infrastructure costs while maintaining performance and reliability. Regular monitoring and adjustment of your usage patterns will help ensure cost efficiency as your workload evolves.
