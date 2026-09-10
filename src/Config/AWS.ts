import AWS from "aws-sdk";

import config from "@Config/Environment";

AWS.config.update({
  accessKeyId: config.aws.access_key_id,
  secretAccessKey: config.aws.secret_access_key,
  region: config.aws.region,
});

export const s3 = new AWS.S3();

export const cloudWatchLogs = new AWS.CloudWatchLogs();

export const translate = new AWS.Translate();

export default AWS;
