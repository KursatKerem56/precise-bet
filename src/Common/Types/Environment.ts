import { EEnvFieldTypes } from "Common/Constants/Environment";

type TEnvField =
  | {
      type: EEnvFieldTypes;
      default: string | number | boolean | object;
      isRequired?: boolean;
      value: string | number | boolean | object | undefined;
    }
  | {
      [key: string]: TEnvField;
    };

interface IEnvConfig {
  [key: string]: TEnvField;
}

export { TEnvField, IEnvConfig };
