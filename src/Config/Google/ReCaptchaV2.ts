import config from "@Config/Environment";
import axios from "axios";

class ReCaptchaV2 {
  private _siteKey: string;
  private _secretKey: string;

  constructor(siteKey: string, secretKey: string) {
    this._siteKey = siteKey;
    this._secretKey = secretKey;
  }

  verify = async (humanKey: string, ip?: string) => {
    const response = await axios.post(
      "https://www.google.com/recaptcha/api/siteverify",
      {
        secret: this._secretKey,
        response: humanKey,
        remoteip: ip,
      },
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
      }
    );

    return response.data.success;
  };
}

const reCaptchaV2 = new ReCaptchaV2(
  config.google.recaptcha_V2.site_key,
  config.google.recaptcha_V2.secret_key
);

export default reCaptchaV2;
