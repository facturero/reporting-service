import { DataTypes, Model, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from './sequelize.js';

export class ReportDocumentModel extends Model<InferAttributes<ReportDocumentModel>, InferCreationAttributes<ReportDocumentModel>> {
  declare id: string;
  declare organization_id: string;
  declare source_service: 'billing' | 'purchasing' | 'fiscal';
  declare source_id: string;
  declare direction: 'sale' | 'purchase' | 'withholding_issued';
  declare document_type_code: string;
  declare establishment: string;
  declare emission_point: string;
  declare sequential: string;
  declare authorization_number: string | null;
  declare issue_date: string;
  declare party_identification_type: string | null;
  declare party_identification: string | null;
  declare party_name: string | null;
  declare support_code: string | null;
  declare payment_method_code: string | null;
  declare currency_code: string;
  declare total_cents: string | number;
  declare status: 'active' | 'voided';
  declare voided_at: Date | null;
  declare related_source_id: string | null;
  declare created_at: Date;
  declare updated_at: Date;
  declare version: number;
}

ReportDocumentModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    source_service: { type: DataTypes.ENUM('billing', 'purchasing', 'fiscal'), allowNull: false },
    source_id: { type: DataTypes.STRING(64), allowNull: false },
    direction: { type: DataTypes.ENUM('sale', 'purchase', 'withholding_issued'), allowNull: false },
    document_type_code: { type: DataTypes.CHAR(2), allowNull: false },
    establishment: { type: DataTypes.CHAR(3), allowNull: false },
    emission_point: { type: DataTypes.CHAR(3), allowNull: false },
    sequential: { type: DataTypes.STRING(9), allowNull: false },
    authorization_number: { type: DataTypes.STRING(49), allowNull: true },
    issue_date: { type: DataTypes.DATEONLY, allowNull: false },
    party_identification_type: { type: DataTypes.STRING(2), allowNull: true },
    party_identification: { type: DataTypes.STRING(20), allowNull: true },
    party_name: { type: DataTypes.STRING(300), allowNull: true },
    support_code: { type: DataTypes.STRING(2), allowNull: true },
    payment_method_code: { type: DataTypes.STRING(2), allowNull: true },
    currency_code: { type: DataTypes.CHAR(3), allowNull: false },
    total_cents: { type: DataTypes.BIGINT, allowNull: false },
    status: { type: DataTypes.ENUM('active', 'voided'), allowNull: false, defaultValue: 'active' },
    voided_at: { type: DataTypes.DATE, allowNull: true },
    related_source_id: { type: DataTypes.STRING(64), allowNull: true },
    created_at: { type: DataTypes.DATE, allowNull: false },
    updated_at: { type: DataTypes.DATE, allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  },
  { sequelize, tableName: 'report_documents', timestamps: false },
);

export class ReportDocumentTaxModel extends Model<InferAttributes<ReportDocumentTaxModel>, InferCreationAttributes<ReportDocumentTaxModel>> {
  declare id: string;
  declare document_id: string;
  declare kind: 'iva' | 'ice' | 'irbpnr';
  declare tax_code: string;
  declare rate_percent: string | number;
  declare base_cents: string | number;
  declare amount_cents: string | number;
}

ReportDocumentTaxModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    document_id: { type: DataTypes.CHAR(36), allowNull: false },
    kind: { type: DataTypes.ENUM('iva', 'ice', 'irbpnr'), allowNull: false },
    tax_code: { type: DataTypes.STRING(10), allowNull: false },
    rate_percent: { type: DataTypes.DECIMAL(6, 3), allowNull: false },
    base_cents: { type: DataTypes.BIGINT, allowNull: false },
    amount_cents: { type: DataTypes.BIGINT, allowNull: false },
  },
  { sequelize, tableName: 'report_document_taxes', timestamps: false },
);

export class ReportWithholdingLineModel extends Model<InferAttributes<ReportWithholdingLineModel>, InferCreationAttributes<ReportWithholdingLineModel>> {
  declare id: string;
  declare document_id: string;
  declare tax: 'income' | 'vat' | 'isd';
  declare concept_code: string;
  declare rate_percent: string | number;
  declare base_cents: string | number;
  declare amount_cents: string | number;
  declare supports_source_id: string | null;
  declare support_document_number: string | null;
  declare support_party_identification: string | null;
}

ReportWithholdingLineModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    document_id: { type: DataTypes.CHAR(36), allowNull: false },
    tax: { type: DataTypes.ENUM('income', 'vat', 'isd'), allowNull: false },
    concept_code: { type: DataTypes.STRING(10), allowNull: false },
    rate_percent: { type: DataTypes.DECIMAL(6, 3), allowNull: false },
    base_cents: { type: DataTypes.BIGINT, allowNull: false },
    amount_cents: { type: DataTypes.BIGINT, allowNull: false },
    supports_source_id: { type: DataTypes.STRING(64), allowNull: true },
    support_document_number: { type: DataTypes.STRING(60), allowNull: true },
    support_party_identification: { type: DataTypes.STRING(20), allowNull: true },
  },
  { sequelize, tableName: 'report_withholding_lines', timestamps: false },
);

export class TaxAnnexRunModel extends Model<InferAttributes<TaxAnnexRunModel>, InferCreationAttributes<TaxAnnexRunModel>> {
  declare id: string;
  declare organization_id: string;
  declare annex: 'ats' | 'f103' | 'f104';
  declare period: string;
  declare version: number;
  declare content_hash: string;
  declare status: 'generated';
  declare generated_by: string;
  declare generated_at: Date;
  declare summary_json: unknown;
  declare content_json: unknown;
  declare xml_content: string | null;
}

TaxAnnexRunModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    annex: { type: DataTypes.ENUM('ats', 'f103', 'f104'), allowNull: false },
    period: { type: DataTypes.CHAR(7), allowNull: false },
    version: { type: DataTypes.INTEGER, allowNull: false },
    content_hash: { type: DataTypes.CHAR(64), allowNull: false },
    status: { type: DataTypes.ENUM('generated'), allowNull: false, defaultValue: 'generated' },
    generated_by: { type: DataTypes.CHAR(36), allowNull: false },
    generated_at: { type: DataTypes.DATE, allowNull: false },
    summary_json: { type: DataTypes.JSON, allowNull: false },
    content_json: { type: DataTypes.JSON, allowNull: false },
    xml_content: { type: DataTypes.TEXT('long'), allowNull: true },
  },
  { sequelize, tableName: 'tax_annex_runs', timestamps: false },
);

export class TaxAnnexFindingModel extends Model<InferAttributes<TaxAnnexFindingModel>, InferCreationAttributes<TaxAnnexFindingModel>> {
  declare id: string;
  declare run_id: string;
  declare severity: 'error' | 'warning';
  declare code: string;
  declare message: string;
  declare document_id: string | null;
}

TaxAnnexFindingModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    run_id: { type: DataTypes.CHAR(36), allowNull: false },
    severity: { type: DataTypes.ENUM('error', 'warning'), allowNull: false },
    code: { type: DataTypes.STRING(40), allowNull: false },
    message: { type: DataTypes.STRING(500), allowNull: false },
    document_id: { type: DataTypes.CHAR(36), allowNull: true },
  },
  { sequelize, tableName: 'tax_annex_findings', timestamps: false },
);

export class TaxAnnexManualInputModel extends Model<InferAttributes<TaxAnnexManualInputModel>, InferCreationAttributes<TaxAnnexManualInputModel>> {
  declare id: string;
  declare organization_id: string;
  declare annex: 'ats' | 'f103' | 'f104';
  declare period: string;
  declare field_code: string;
  declare amount_cents: string | number;
  declare set_by: string;
  declare set_at: Date;
}

TaxAnnexManualInputModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    organization_id: { type: DataTypes.CHAR(36), allowNull: false },
    annex: { type: DataTypes.ENUM('ats', 'f103', 'f104'), allowNull: false },
    period: { type: DataTypes.CHAR(7), allowNull: false },
    field_code: { type: DataTypes.STRING(20), allowNull: false },
    amount_cents: { type: DataTypes.BIGINT, allowNull: false },
    set_by: { type: DataTypes.CHAR(36), allowNull: false },
    set_at: { type: DataTypes.DATE, allowNull: false },
  },
  { sequelize, tableName: 'tax_annex_manual_inputs', timestamps: false },
);

// ── Outbox para outbox-relay (mismo patrón que treasury-service). La tabla de entrada (processed_events) la gestiona la librería ──

export class OutboxModel extends Model<InferAttributes<OutboxModel>, InferCreationAttributes<OutboxModel>> {
  declare id: string;
  declare aggregate_type: string;
  declare aggregate_id: string;
  declare type: string;
  declare payload: unknown;
  declare occurred_at: Date;
  declare processed_at: Date | null;
}

OutboxModel.init(
  {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    aggregate_type: { type: DataTypes.STRING(50), allowNull: false },
    aggregate_id: { type: DataTypes.CHAR(36), allowNull: false },
    type: { type: DataTypes.STRING(100), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false },
    occurred_at: { type: DataTypes.DATE, allowNull: false },
    processed_at: { type: DataTypes.DATE, allowNull: true },
  },
  { sequelize, tableName: 'outbox_messages', timestamps: false },
);
