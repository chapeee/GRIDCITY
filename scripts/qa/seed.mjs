// Seeds LocalStack (buckets with folders and a backup) and Moto (an ALB with two
// healthy targets, a private RDS) for the QA pass. Safe to run again.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const { S3Client, CreateBucketCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const {
  ElasticLoadBalancingV2Client,
  CreateLoadBalancerCommand,
  CreateTargetGroupCommand,
  RegisterTargetsCommand,
  CreateListenerCommand,
} = require('@aws-sdk/client-elastic-load-balancing-v2');
const {
  EC2Client,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  RunInstancesCommand,
} = require('@aws-sdk/client-ec2');
const { RDSClient, CreateDBInstanceCommand } = require('@aws-sdk/client-rds');
const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
const s3 = new S3Client({
  region: 'us-east-1',
  endpoint: 'http://127.0.0.1:4566',
  forcePathStyle: true,
  credentials,
});
for (const b of ['app-media', 'app-backups'])
  await s3.send(new CreateBucketCommand({ Bucket: b })).catch(() => {});
for (let i = 0; i < 5; i++)
  await s3.send(
    new PutObjectCommand({
      Bucket: 'app-media',
      Key: `images/pic-${i}.txt`,
      Body: 'x'.repeat(1000 * (i + 1)),
    }),
  );
await s3.send(
  new PutObjectCommand({ Bucket: 'app-media', Key: 'docs/readme.md', Body: '# hello' }),
);
await s3.send(
  new PutObjectCommand({
    Bucket: 'app-backups',
    Key: 'db/nightly-2026-11-14.sql.gz',
    Body: 'y'.repeat(50000),
  }),
);
console.log('s3 seeded');
const moto = { region: 'us-east-1', endpoint: 'http://127.0.0.1:5000', credentials };
const ec2 = new EC2Client(moto);
const vpcs = await ec2.send(new DescribeVpcsCommand({}));
const subnets = await ec2.send(new DescribeSubnetsCommand({}));
const sub = subnets.Subnets.slice(0, 2).map((s) => s.SubnetId);
const elb = new ElasticLoadBalancingV2Client(moto);
try {
  const lb = await elb.send(
    new CreateLoadBalancerCommand({ Name: 'web-alb', Subnets: sub, Type: 'application' }),
  );
  const tg = await elb.send(
    new CreateTargetGroupCommand({
      Name: 'web-tg',
      Protocol: 'HTTP',
      Port: 80,
      VpcId: vpcs.Vpcs[0].VpcId,
    }),
  );
  const inst = await ec2.send(
    new RunInstancesCommand({ ImageId: 'ami-12c6146b', MinCount: 2, MaxCount: 2 }),
  );
  await elb.send(
    new RegisterTargetsCommand({
      TargetGroupArn: tg.TargetGroups[0].TargetGroupArn,
      Targets: inst.Instances.map((i) => ({ Id: i.InstanceId })),
    }),
  );
  await elb.send(
    new CreateListenerCommand({
      LoadBalancerArn: lb.LoadBalancers[0].LoadBalancerArn,
      Protocol: 'HTTP',
      Port: 80,
      DefaultActions: [{ Type: 'forward', TargetGroupArn: tg.TargetGroups[0].TargetGroupArn }],
    }),
  );
  console.log('alb seeded');
} catch (e) {
  console.log('alb:', e.name, e.message);
}
await new RDSClient(moto)
  .send(
    new CreateDBInstanceCommand({
      DBInstanceIdentifier: 'orders-db',
      Engine: 'mysql',
      DBInstanceClass: 'db.t3.micro',
      AllocatedStorage: 20,
      MasterUsername: 'admin',
      MasterUserPassword: 'lab-only-password',
      PubliclyAccessible: false,
    }),
  )
  .catch((e) => console.log('rds:', e.name));
console.log('rds seeded');
