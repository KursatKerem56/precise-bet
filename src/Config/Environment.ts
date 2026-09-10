import "dotenv/config";

import { IEnvConfig } from "@Common/Types";

import { EEnvFieldTypes } from "@Common/Constants/Environment";

const envConfig = {
  log: {
    level: {
      type: EEnvFieldTypes.NUMBER,
      default: 0,
      value: process.env.LOG_LEVEL,
    },
    level_for_file: {
      type: EEnvFieldTypes.NUMBER,
      default: 0,
      value: process.env.LOG_LEVEL_FOR_FILE,
    },
    level_for_webhook: {
      type: EEnvFieldTypes.NUMBER,
      default: 0,
      value: process.env.LOG_LEVEL_FOR_WEBHOOK,
    },
    level_for_cloudwatch: {
      type: EEnvFieldTypes.NUMBER,
      default: 0,
      value: process.env.LOG_LEVEL_FOR_CLOUDWATCH,
    },
    delete_older_than: {
      type: EEnvFieldTypes.NUMBER,
      default: 0,
      value: process.env.LOG_DELETE_OLDER_THAN,
    },
  },
  aws: {
    access_key_id: {
      type: EEnvFieldTypes.STRING,
      default: "",
      isRequired: true,
      value: process.env.AWS_ACCESS_KEY_ID,
    },
    secret_access_key: {
      type: EEnvFieldTypes.STRING,
      default: "",
      isRequired: true,
      value: process.env.AWS_SECRET_ACCESS_KEY,
    },
    region: {
      type: EEnvFieldTypes.STRING,
      default: "eu-central-1",
      value: process.env.AWS_REGION,
    },
    s3: {
      bucket: {
        type: EEnvFieldTypes.STRING,
        default: "test-bucket",
        isRequired: true,
        value: process.env.AWS_S3_BUCKET,
      },
    },
  },
  google: {
    recaptcha_V2: {
      site_key: {
        type: EEnvFieldTypes.STRING,
        default: "",
        value: process.env.GOOGLE_RECAPTCHA_V2_SITE_KEY,
      },
      secret_key: {
        type: EEnvFieldTypes.STRING,
        default: "",
        value: process.env.GOOGLE_RECAPTCHA_V2_SECRET_KEY,
      },
    },
    login: {
      client_id: {
        type: EEnvFieldTypes.STRING,
        default: "",
        value: process.env.GOOGLE_CLIENT_ID,
      },
      client_secret: {
        type: EEnvFieldTypes.STRING,
        default: "",
        value: process.env.GOOGLE_CLIENT_SECRET,
      },
    },
  },
  db: {
    mongo: {
      uri: {
        type: EEnvFieldTypes.STRING,
        default: "mongodb://localhost:27017/cgg",
        value: process.env.MONGO_URI,
      },
    },
    redis: {
      uri: {
        type: EEnvFieldTypes.STRING,
        default: "localhost",
        value: process.env.REDIS_URI,
      },
    },
  },
  app: {
    url: {
      type: EEnvFieldTypes.STRING,
      default: "http://localhost:3005",
      value: process.env.APP_URL,
    },
    domain: {
      type: EEnvFieldTypes.STRING,
      default: "localhost",
      value: process.env.APP_DOMAIN,
    },
    port: {
      type: EEnvFieldTypes.NUMBER,
      default: 3005,
      value: process.env.APP_PORT,
    },
  },
  frontend: {
    url: {
      type: EEnvFieldTypes.STRING,
      default: "http://localhost:8080",
      value: process.env.FRONTEND_URL,
    },
  },
  session: {
    secret: {
      type: EEnvFieldTypes.STRING,
      default: "secret",
      value: process.env.SESSION_SECRET,
    },
    prefix: {
      type: EEnvFieldTypes.STRING,
      default: "cgg",
      value: process.env.SESSION_PREFIX,
    },
  },
  auth: {
    jwt: {
      secret: {
        type: EEnvFieldTypes.STRING,
        default: "secret",
        value: process.env.JWT_SECRET,
      },
      refresh_secret: {
        type: EEnvFieldTypes.STRING,
        default: "secret",
        value: process.env.JWT_REFRESH_SECRET,
      },
      expire_time: {
        type: EEnvFieldTypes.NUMBER,
        default: 60 * 1000 * 60,
        value: process.env.JWT_EXPIRE_TIME,
      },
      refresh_expire_time: {
        type: EEnvFieldTypes.NUMBER,
        default: 60 * 60 * 24 * 7 * 1000,
        value: process.env.JWT_REFRESH_EXPIRE_TIME,
      },
    },
  },
  site: {},
};

const setupConfig = (envConfig: IEnvConfig) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const checkFieldsAndSet = (obj: any) => {
    for (const key in obj) {
      if (obj[key].isRequired && !obj[key].value) {
        throw new Error("REQUIRED_FIELD_NOT_SET:" + key);
      }

      if (typeof obj[key] === "object" && !obj[key].type) {
        obj[key] = checkFieldsAndSet(obj[key]);
      } else {
        if (obj[key].value) {
          obj[key].value = obj[key].value.trim();
        } else {
          obj[key].value = obj[key].default;
        }

        if (obj[key].type === EEnvFieldTypes.NUMBER) {
          obj[key].value = Number(obj[key].value);
        }

        if (obj[key].type === EEnvFieldTypes.BOOLEAN) {
          obj[key].value = Boolean(obj[key].value);
        }

        if (obj[key].type === EEnvFieldTypes.JSON) {
          try {
            obj[key].value = JSON.parse(obj[key].value);
          } catch (err) {
            throw new Error("JSON_PARSE_ERROR");
          }
        }

        if (obj[key].type === EEnvFieldTypes.STRING_ARRAY) {
          obj[key].value = obj[key].value.split(",");

          obj[key].value = obj[key].value.map((item: string) => item.trim());
        }

        obj[key] = obj[key].value || obj[key].default;
      }
    }

    return obj;
  };

  return checkFieldsAndSet(envConfig);
};

const config = setupConfig(envConfig);

export default config;
