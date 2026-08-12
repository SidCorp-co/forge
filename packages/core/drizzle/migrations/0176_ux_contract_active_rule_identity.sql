CREATE UNIQUE INDEX "ux_contract_rules_active_identity_uq"
  ON "ux_contract_rules" ("project_id", "group", "order_index")
  WHERE "status" = 'active';
