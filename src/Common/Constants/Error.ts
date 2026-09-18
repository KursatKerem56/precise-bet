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
  UNEXPECTED_ERROR: {
    message: "Unexpected error",
    locale_key: "api.error.unexpected_error",
    type: EErrorType.GENERIC,
    service: EErrorService.NONE,
    statusCode: 500,
  },
  MISSING_PARAMETERS: {
    message: "Missing parameters",
    locale_key: "api.error.missingParameters",
    type: EErrorType.VALIDATION,
    service: EErrorService.NONE,
    statusCode: 400,
  },
  INVALID_SITE: {
    message: "Invalid site",
    locale_key: "api.error.invalid_site",
    type: EErrorType.VALIDATION,
    service: EErrorService.NONE,
    statusCode: 400,
  },
};

export { Errors, EErrorType, EErrorService };
