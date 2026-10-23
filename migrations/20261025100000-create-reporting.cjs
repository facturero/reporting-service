'use strict';

/**
 * Migración idempotente para crear las tablas de reporting-service.
 * Se ejecuta en el initContainer reporting-migrate antes de arrancar el servicio.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const tableNames = tables.map(t => t.toLowerCase());

    // 1. report_documents
    if (!tableNames.includes('report_documents')) {
      await queryInterface.createTable('report_documents', {
        id: { type: Sequelize.CHAR(36), primaryKey: true },
        organization_id: { type: Sequelize.CHAR(36), allowNull: false },
        source_service: { type: Sequelize.ENUM('billing', 'purchasing', 'fiscal'), allowNull: false },
        source_id: { type: Sequelize.STRING(64), allowNull: false },
        direction: { type: Sequelize.ENUM('sale', 'purchase', 'withholding_issued'), allowNull: false },
        document_type_code: { type: Sequelize.CHAR(2), allowNull: false },
        establishment: { type: Sequelize.CHAR(3), allowNull: false },
        emission_point: { type: Sequelize.CHAR(3), allowNull: false },
        sequential: { type: Sequelize.STRING(9), allowNull: false },
        authorization_number: { type: Sequelize.STRING(49), allowNull: true },
        issue_date: { type: Sequelize.DATEONLY, allowNull: false },
        party_identification_type: { type: Sequelize.STRING(2), allowNull: true },
        party_identification: { type: Sequelize.STRING(20), allowNull: true },
        party_name: { type: Sequelize.STRING(300), allowNull: true },
        support_code: { type: Sequelize.STRING(2), allowNull: true },
        payment_method_code: { type: Sequelize.STRING(2), allowNull: true },
        currency_code: { type: Sequelize.CHAR(3), allowNull: false },
        total_cents: { type: Sequelize.BIGINT, allowNull: false },
        status: { type: Sequelize.ENUM('active', 'voided'), allowNull: false, defaultValue: 'active' },
        voided_at: { type: Sequelize.DATE, allowNull: true },
        related_source_id: { type: Sequelize.STRING(64), allowNull: true },
        created_at: { type: Sequelize.DATE, allowNull: false },
        updated_at: { type: Sequelize.DATE, allowNull: false },
        version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      });
    }

    // Índices y UNIQUE para report_documents
    const docIndexes = await queryInterface.showIndex('report_documents');
    const docIndexNames = docIndexes.map(i => i.name);
    if (!docIndexNames.includes('uq_report_documents_org_source')) {
      await queryInterface.addConstraint('report_documents', {
        fields: ['organization_id', 'source_service', 'source_id'],
        type: 'unique',
        name: 'uq_report_documents_org_source',
      });
    }
    if (!docIndexNames.includes('idx_report_documents_org_period')) {
      await queryInterface.addIndex('report_documents', ['organization_id', 'issue_date'], {
        name: 'idx_report_documents_org_period',
      });
    }
    if (!docIndexNames.includes('idx_report_documents_org_status')) {
      await queryInterface.addIndex('report_documents', ['organization_id', 'status'], {
        name: 'idx_report_documents_org_status',
      });
    }

    // 2. report_document_taxes
    if (!tableNames.includes('report_document_taxes')) {
      await queryInterface.createTable('report_document_taxes', {
        id: { type: Sequelize.CHAR(36), primaryKey: true },
        document_id: { type: Sequelize.CHAR(36), allowNull: false },
        kind: { type: Sequelize.ENUM('iva', 'ice', 'irbpnr'), allowNull: false },
        tax_code: { type: Sequelize.STRING(10), allowNull: false },
        rate_percent: { type: Sequelize.DECIMAL(6, 3), allowNull: false },
        base_cents: { type: Sequelize.BIGINT, allowNull: false },
        amount_cents: { type: Sequelize.BIGINT, allowNull: false },
      });
    }
    const taxIndexes = await queryInterface.showIndex('report_document_taxes');
    const taxIndexNames = taxIndexes.map(i => i.name);
    if (!taxIndexNames.includes('idx_report_document_taxes_doc')) {
      await queryInterface.addIndex('report_document_taxes', ['document_id'], {
        name: 'idx_report_document_taxes_doc',
      });
    }

    // 3. report_withholding_lines
    if (!tableNames.includes('report_withholding_lines')) {
      await queryInterface.createTable('report_withholding_lines', {
        id: { type: Sequelize.CHAR(36), primaryKey: true },
        document_id: { type: Sequelize.CHAR(36), allowNull: false },
        tax: { type: Sequelize.ENUM('income', 'vat', 'isd'), allowNull: false },
        concept_code: { type: Sequelize.STRING(10), allowNull: false },
        rate_percent: { type: Sequelize.DECIMAL(6, 3), allowNull: false },
        base_cents: { type: Sequelize.BIGINT, allowNull: false },
        amount_cents: { type: Sequelize.BIGINT, allowNull: false },
        supports_source_id: { type: Sequelize.STRING(64), allowNull: true },
        support_document_number: { type: Sequelize.STRING(60), allowNull: true },
        support_party_identification: { type: Sequelize.STRING(20), allowNull: true },
      });
    }
    const whIndexes = await queryInterface.showIndex('report_withholding_lines');
    const whIndexNames = whIndexes.map(i => i.name);
    if (!whIndexNames.includes('idx_report_withholding_lines_doc')) {
      await queryInterface.addIndex('report_withholding_lines', ['document_id'], {
        name: 'idx_report_withholding_lines_doc',
      });
    }
    if (!whIndexNames.includes('idx_report_withholding_lines_supports')) {
      await queryInterface.addIndex('report_withholding_lines', ['supports_source_id'], {
        name: 'idx_report_withholding_lines_supports',
      });
    }

    // 4. tax_annex_runs
    if (!tableNames.includes('tax_annex_runs')) {
      await queryInterface.createTable('tax_annex_runs', {
        id: { type: Sequelize.CHAR(36), primaryKey: true },
        organization_id: { type: Sequelize.CHAR(36), allowNull: false },
        annex: { type: Sequelize.ENUM('ats', 'f103', 'f104'), allowNull: false },
        period: { type: Sequelize.CHAR(7), allowNull: false },
        version: { type: Sequelize.INTEGER, allowNull: false },
        content_hash: { type: Sequelize.CHAR(64), allowNull: false },
        status: { type: Sequelize.ENUM('generated'), allowNull: false, defaultValue: 'generated' },
        generated_by: { type: Sequelize.CHAR(36), allowNull: false },
        generated_at: { type: Sequelize.DATE, allowNull: false },
        summary_json: { type: Sequelize.JSON, allowNull: false },
        content_json: { type: Sequelize.JSON, allowNull: false },
        xml_content: { type: Sequelize.TEXT('long'), allowNull: true },
      });
    }
    const runIndexes = await queryInterface.showIndex('tax_annex_runs');
    const runIndexNames = runIndexes.map(i => i.name);
    if (!runIndexNames.includes('uq_tax_annex_runs_org_annex_period_version')) {
      await queryInterface.addConstraint('tax_annex_runs', {
        fields: ['organization_id', 'annex', 'period', 'version'],
        type: 'unique',
        name: 'uq_tax_annex_runs_org_annex_period_version',
      });
    }
    if (!runIndexNames.includes('idx_tax_annex_runs_org_period')) {
      await queryInterface.addIndex('tax_annex_runs', ['organization_id', 'period', 'annex'], {
        name: 'idx_tax_annex_runs_org_period',
      });
    }

    // 5. tax_annex_findings
    if (!tableNames.includes('tax_annex_findings')) {
      await queryInterface.createTable('tax_annex_findings', {
        id: { type: Sequelize.CHAR(36), primaryKey: true },
        run_id: { type: Sequelize.CHAR(36), allowNull: false },
        severity: { type: Sequelize.ENUM('error', 'warning'), allowNull: false },
        code: { type: Sequelize.STRING(40), allowNull: false },
        message: { type: Sequelize.STRING(500), allowNull: false },
        document_id: { type: Sequelize.CHAR(36), allowNull: true },
      });
    }
    const findingIndexes = await queryInterface.showIndex('tax_annex_findings');
    const findingIndexNames = findingIndexes.map(i => i.name);
    if (!findingIndexNames.includes('idx_tax_annex_findings_run')) {
      await queryInterface.addIndex('tax_annex_findings', ['run_id'], {
        name: 'idx_tax_annex_findings_run',
      });
    }

    // 6. tax_annex_manual_inputs
    if (!tableNames.includes('tax_annex_manual_inputs')) {
      await queryInterface.createTable('tax_annex_manual_inputs', {
        id: { type: Sequelize.CHAR(36), primaryKey: true },
        organization_id: { type: Sequelize.CHAR(36), allowNull: false },
        annex: { type: Sequelize.ENUM('ats', 'f103', 'f104'), allowNull: false },
        period: { type: Sequelize.CHAR(7), allowNull: false },
        field_code: { type: Sequelize.STRING(20), allowNull: false },
        amount_cents: { type: Sequelize.BIGINT, allowNull: false },
        set_by: { type: Sequelize.CHAR(36), allowNull: false },
        set_at: { type: Sequelize.DATE, allowNull: false },
      });
    }
    const manualIndexes = await queryInterface.showIndex('tax_annex_manual_inputs');
    const manualIndexNames = manualIndexes.map(i => i.name);
    if (!manualIndexNames.includes('uq_tax_annex_manual_inputs')) {
      await queryInterface.addConstraint('tax_annex_manual_inputs', {
        fields: ['organization_id', 'annex', 'period', 'field_code'],
        type: 'unique',
        name: 'uq_tax_annex_manual_inputs',
      });
    }

    // 7. outbox_messages (para outbox-relay)
    if (!tableNames.includes('outbox_messages')) {
      await queryInterface.createTable('outbox_messages', {
        id: { type: Sequelize.CHAR(36), primaryKey: true },
        aggregate_type: { type: Sequelize.STRING(50), allowNull: false },
        aggregate_id: { type: Sequelize.CHAR(36), allowNull: false },
        type: { type: Sequelize.STRING(100), allowNull: false },
        payload: { type: Sequelize.JSON, allowNull: false },
        occurred_at: { type: Sequelize.DATE, allowNull: false },
        processed_at: { type: Sequelize.DATE, allowNull: true },
      });
    }
    const outboxIndexes = await queryInterface.showIndex('outbox_messages');
    const outboxIndexNames = outboxIndexes.map(i => i.name);
    if (!outboxIndexNames.includes('idx_outbox_processed')) {
      await queryInterface.addIndex('outbox_messages', ['processed_at'], {
        name: 'idx_outbox_processed',
      });
    }

    // 8. processed_events: tabla de entrada del InboxConsumer de @facturero/outbox-relay 0.2.x (mismo esquema que treasury-service).
    //    Si no existe con este esquema, el consumidor no arranca o no deduplica.
    if (!tableNames.includes('processed_events')) {
      await queryInterface.createTable('processed_events', {
        id: { type: Sequelize.CHAR(36), primaryKey: true },
        event_type: { type: Sequelize.STRING(100), allowNull: false },
        routing_key: { type: Sequelize.STRING(200), allowNull: false },
        payload: { type: Sequelize.JSON, allowNull: false },
        status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'processed' },
        last_error: { type: Sequelize.TEXT, allowNull: true },
        processed_at: { type: Sequelize.DATE, allowNull: false },
      });
    }
  },

  async down(queryInterface, Sequelize) {
    // No se borra nada en producción; esta migración es idempotente y solo crea.
    // Si se necesita rollback, se hace manualmente.
  },
};