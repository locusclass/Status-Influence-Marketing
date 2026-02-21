export async function healthRoutes(app) {
    app.get('/health', async () => {
        return { ok: true, ts: new Date().toISOString() };
    });
}
