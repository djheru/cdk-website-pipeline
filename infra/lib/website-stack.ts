import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { DnsValidatedCertificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  AllowedMethods,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CachePolicy,
  CacheQueryStringBehavior,
  Distribution,
  LambdaEdgeEventType,
  OriginAccessIdentity,
  OriginRequestPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3Origin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { ARecord, HostedZone, IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { CloudFrontTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import {
  Environment,
  WebsitePipeline,
  WebsitePipelineBaseProps,
} from './website-pipeline';

export interface WebsiteStackProps extends StackProps {
  domainName: string;
  environmentName: Environment;
  serviceName: string;
  pipelineProps: WebsitePipelineBaseProps;
}

export class WebsiteStack extends Stack {
  public hostedZone: IHostedZone;
  public certificate: DnsValidatedCertificate;
  public aRecord: ARecord;
  public hostedZoneDomainName: string;
  public fullDomainName: string;
  public blueBucket: Bucket;
  public greenBucket: Bucket;
  public oai: OriginAccessIdentity;
  public blueOrigin: S3Origin;
  public greenOrigin: S3Origin;
  public edgeOriginRequestFunction: NodejsFunction;
  public edgeViewerRequestFunction: NodejsFunction;
  public distribution: Distribution;
  public pipeline: WebsitePipeline;

  constructor(
    scope: Construct,
    private readonly id: string,
    private readonly props: WebsiteStackProps
  ) {
    super(scope, id, props);

    /**
     * "Base" domain name from hosted zone. For prod, it's just the domain from the .env file
     * For other envs, it's e.g. `dev.example.com`
     * It is the name we'll use to look up the hosted zone
     */
    this.hostedZoneDomainName =
      this.props.environmentName === 'prod'
        ? this.props.domainName
        : `${this.props.environmentName}.${this.props.domainName}`;

    /**
     * The domain name where the site will be served. We use this to create
     * the A Record and certificate
     */
    this.fullDomainName = `${this.props.serviceName}.${this.hostedZoneDomainName}`;

    this.buildResources();
  }

  buildResources() {
    this.importHostedZone();
    this.buildCertificate();
    this.buildDeployBuckets();
    this.buildOAI();
    this.buildS3Origins();
    this.buildEdgeLambdas();
    this.buildDistribution();
    this.buildARecord();
    this.buildPipeline();
  }

  /**
   * Look up the existing Route53 hosted zone to use for
   */
  importHostedZone() {
    const zoneId = `${this.id}-hosted-zone`;
    this.hostedZone = HostedZone.fromLookup(this, zoneId, {
      domainName: this.hostedZoneDomainName,
    });
  }

  /**
   * Build a DNS validated certificate with the full domain name
   */
  buildCertificate() {
    const certId = `${this.id}-certificate`;
    this.certificate = new DnsValidatedCertificate(this, certId, {
      domainName: this.fullDomainName,
      hostedZone: this.hostedZone,
    });
  }

  /**
   * Two S3 buckets for Blue/Green deployments
   * NOTE: The removal policy is DESTROY, so they will not persist if you
   * remove the CloudFormation stack
   */
  buildDeployBuckets() {
    const bucketBaseId = `${this.id}-bucket`;
    const blueBucketId = `${bucketBaseId}-blue`;
    const greenBucketId = `${bucketBaseId}-green`;

    this.blueBucket = new Bucket(this, blueBucketId, {
      versioned: false,
      bucketName: `${blueBucketId}-${this.region}-${this.account}`,
      publicReadAccess: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.greenBucket = new Bucket(this, greenBucketId, {
      versioned: false,
      bucketName: `${greenBucketId}-${this.region}-${this.account}`,
      publicReadAccess: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  /**
   * Builds the Origin Access Identity, which is a special CloudFront user you
   * can associate with S3 origins and restrict access
   */
  buildOAI() {
    const oaiId = `${this.id}-oai`;
    this.oai = new OriginAccessIdentity(this, `${oaiId}-blue`, {
      comment: `Origin Access Identity for ${this.id} (Blue)`,
    });

    this.blueBucket.grantRead(this.oai);
    this.greenBucket.grantRead(this.oai);
  }

  /**
   * Sets up an Origin resource that the CloudFront Distribution connects to
   */
  buildS3Origins() {
    this.blueOrigin = new S3Origin(this.blueBucket, {
      originAccessIdentity: this.oai,
    });
    this.greenOrigin = new S3Origin(this.greenBucket, {
      originAccessIdentity: this.oai,
    });
  }

  /**
   * Edge lambdas intercept requests going to S3 and responses coming back
   * We use them to handle headers and route between the Green/Blue buckets
   */
  buildEdgeLambdas() {
    const lambdaId = `${this.id}-blue-green-edge`;
    this.edgeOriginRequestFunction = new NodejsFunction(this, `${lambdaId}-origin`, {
      entry: './lib/lambda/blue-green.origin-request.ts',
    });
    this.edgeViewerRequestFunction = new NodejsFunction(this, `${lambdaId}-viewer`, {
      entry: './lib/lambda/blue-green.viewer-request.ts',
    });
  }

  /**
   * Configures and builds a CloudFront distribution
   * Configured to add the `x-blue-green-context` header to the cache
   */
  buildDistribution() {
    const distributionId = `${this.id}-distribution`;
    const cachePolicy = new CachePolicy(this, `${distributionId}-cache-policy`, {
      comment: `Cache Policy for ${distributionId}`,
      headerBehavior: CacheHeaderBehavior.allowList('x-blue-green-context'),
      cookieBehavior: CacheCookieBehavior.all(),
      queryStringBehavior: CacheQueryStringBehavior.all(),
    });
    const originRequestPolicy = OriginRequestPolicy.CORS_S3_ORIGIN;
    this.distribution = new Distribution(this, distributionId, {
      defaultBehavior: {
        origin: this.blueOrigin,
        cachePolicy,
        originRequestPolicy,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        edgeLambdas: [
          {
            eventType: LambdaEdgeEventType.VIEWER_REQUEST,
            functionVersion: this.edgeViewerRequestFunction.currentVersion,
          },
          {
            eventType: LambdaEdgeEventType.ORIGIN_REQUEST,
            functionVersion: this.edgeOriginRequestFunction.currentVersion,
          },
        ],
      },
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
      defaultRootObject: 'index.html',
      domainNames: [this.fullDomainName],
      certificate: this.certificate,
      enableLogging: true,
    });
  }

  /**
   * Builds an A Record for the domain name that points to the CloudFront Distribution
   */
  buildARecord() {
    const aRecordId = `${this.id}-a-record`;
    this.aRecord = new ARecord(this, aRecordId, {
      zone: this.hostedZone,
      recordName: this.fullDomainName,
      target: RecordTarget.fromAlias(new CloudFrontTarget(this.distribution)),
    });

    const aRecordOutputId = `${aRecordId}-domain-name`;
    new CfnOutput(this, aRecordOutputId, {
      value: this.aRecord.domainName,
      exportName: aRecordOutputId,
    });
  }

  buildPipeline() {
    const pipelineId = `${this.id}-cicd`;
    this.pipeline = new WebsitePipeline(this, pipelineId, {
      blueBucket: this.blueBucket,
      greenBucket: this.greenBucket,
      distributionId: this.distribution.distributionId,
      ...this.props.pipelineProps,
    });
  }
}
