export function validateBody(schema, request) {
    return schema.parse(request.body);
}
