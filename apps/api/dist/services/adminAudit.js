export async function recordAdminAudit(client, input) {
    await client.query(`
    INSERT INTO admin_audit_logs (
      actor_id,
      action,
      target_type,
      target_id,
      meta,
      country_id,
      division_id
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    `, [
        input.actorId ?? null,
        input.action,
        input.targetType,
        input.targetId ?? null,
        input.meta ?? null,
        input.countryId ?? null,
        input.divisionId ?? null,
    ]);
}
export function auditScopeFromAccess(access) {
    const countryScope = access.country_scopes[0] ?? null;
    const divisionScope = access.division_scopes[0] ?? null;
    return {
        countryId: access.country_scopes.length === 1 ? countryScope?.id ?? null : null,
        divisionId: access.division_scopes.length === 1 ? divisionScope?.id ?? null : null,
    };
}
