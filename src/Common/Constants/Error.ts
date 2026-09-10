import config from "@Config/Environment";

import { IError } from "@Common/Types";

enum EErrorType {
  GENERIC = "GENERIC",
  VALIDATION = "VALIDATION",
  TRANSACTION = "TRANSACTION",
  AUTH = "AUTH",
  ACTION = "ACTION",
  TYPE = "TYPE",
}

enum EErrorService {
  NONE = "NONE",
}

const Errors: Record<string, IError> = {
  NONE: {
    message: "None",
    locale_key: "api.error.none",
    type: EErrorType.GENERIC,
    service: EErrorService.NONE,
    statusCode: 400,
  },
};

export { Errors, EErrorType, EErrorService };
