import { EErrorService, EErrorType } from "@Common/Constants";

interface IError {
  message: string;
  locale_key: string;
  type: EErrorType;
  service: EErrorService;
  statusCode: number;
}

export { IError };
