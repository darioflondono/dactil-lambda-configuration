export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || undefined;
  }
}

export const badRequest = (m) => new ApiError(400, m, 'BAD_REQUEST');
export const unauthorized = (m = 'No autorizado') => new ApiError(401, m, 'UNAUTHORIZED');
export const forbidden = (m = 'Prohibido') => new ApiError(403, m, 'FORBIDDEN');
export const notFound = (m = 'No encontrado') => new ApiError(404, m, 'NOT_FOUND');
export const conflict = (m) => new ApiError(409, m, 'CONFLICT');
