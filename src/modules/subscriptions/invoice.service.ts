import PDFDocument from 'pdfkit';
import { prisma } from '../../db/prisma.js';
import { Errors } from '../../utils/AppError.js';
import { toMoneyString } from '../../utils/money.js';
import { effectiveEntitlement } from './entitlement.service.js';
import type { AgentProfileModel, AgentSubscriptionModel, SubscriptionPlanModel } from '../../../generated/prisma/models.js';

type InvoiceSubscription = AgentSubscriptionModel & { plan: SubscriptionPlanModel; agent: AgentProfileModel };

// Shared by both the Agent's own "Subscription History" download and
// Admin's (Active Subscriptions / Subscription History) - `agentId` is only
// passed on the Agent-facing path, where it also enforces ownership; Admin
// can fetch any agent's row.
export async function getSubscriptionForInvoice(id: string, agentId?: string): Promise<InvoiceSubscription> {
  const subscription = await prisma.agentSubscription.findUnique({ where: { id }, include: { plan: true, agent: true } });
  if (!subscription || (agentId && subscription.agentId !== agentId)) throw Errors.notFound('Subscription');
  return subscription;
}

function invoiceNumber(subscription: InvoiceSubscription): string {
  const datePart = subscription.createdAt.toISOString().slice(0, 10).replace(/-/g, '');
  return `ADM-${datePart}-${subscription.id.slice(0, 8).toUpperCase()}`;
}

function formatDate(date: Date | null): string {
  return date ? date.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: '2-digit' }) : '—';
}

// Matches this app's own status-badge color language (campaign-status.util.ts
// / the Ionic wallet page's withdrawal states) so the PDF reads consistently
// with what an Agent/Admin already sees on screen.
const STATUS_COLORS: Record<string, string> = {
  ACTIVE: '#18b67a',
  PENDING: '#e08a00',
  EXPIRED: '#ee5a57',
  CANCELLED: '#ee5a57',
};

const BRAND = '#5856d6'; // This app's own --cui-primary (angular-agent-admin/src/scss/_custom.scss)
const BRAND_SOFT = '#f0eefc';
const INK = '#15172a';
const MUTED = '#6b7785';
const LINE = '#e4e2f5';

// Draws a label+value pair at a fixed x, advancing y by exactly the height
// consumed (pdfkit's own `.y` cursor is shared across the whole document,
// which breaks the moment two side-by-side columns interleave writes to
// it - explicit y-tracking per column, never reading `doc.y` back except
// immediately after a write to that same column, is what actually keeps
// this layout from overlapping itself).
function drawField(doc: PDFKit.PDFDocument, x: number, y: number, width: number, label: string, value: string, valueColor = INK): number {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(label.toUpperCase(), x, y, { width, characterSpacing: 0.3 });
  const afterLabel = doc.y;
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(valueColor).text(value, x, afterLabel + 1, { width });
  return doc.y + 10;
}

function statusBadge(doc: PDFKit.PDFDocument, x: number, y: number, status: string): void {
  const color = STATUS_COLORS[status] ?? MUTED;
  const label = status.charAt(0) + status.slice(1).toLowerCase();
  doc.font('Helvetica-Bold').fontSize(9);
  const width = doc.widthOfString(label) + 16;
  doc.roundedRect(x, y, width, 16, 8).fill(color);
  doc.fillColor('#fff').text(label, x, y + 4, { width, align: 'center' });
}

function planFeatures(plan: SubscriptionPlanModel): string[] {
  return Array.isArray(plan.features) ? (plan.features as unknown[]).filter((f): f is string => typeof f === 'string') : [];
}

// Draws a full, on-brand receipt - only the agent's own billing fields that
// are actually filled in are printed (Business Profile/Billing fields are
// all optional, so nothing here is ever invented), and the row's real
// status is always shown as-is (colored badge included) rather than
// implying every download is a currently-valid, paid-up period.
export function renderInvoicePdf(subscription: InvoiceSubscription): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width; // 595.28
    const left = 50;
    const right = pageWidth - 50; // 545.28

    // --- Header band -------------------------------------------------
    doc.rect(0, 0, pageWidth, 110).fill(BRAND);
    doc.font('Helvetica-Bold').fontSize(24).fillColor('#fff').text('AdMobility', left, 34);
    doc.font('Helvetica').fontSize(10).fillColor('#e4e1fb').text('Subscription Invoice', left, 64);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#fff').text('INVOICE', left, 32, { width: right - left, align: 'right' });
    doc.font('Helvetica').fontSize(10).fillColor('#e4e1fb').text(invoiceNumber(subscription), left, 48, { width: right - left, align: 'right' });

    // --- Meta strip (date / billing period / status) ------------------
    const metaTop = 130;
    doc
      .roundedRect(left, metaTop, right - left, 56, 6)
      .fillColor(BRAND_SOFT)
      .fill();
    const colWidth = (right - left - 30) / 3;
    drawField(doc, left + 15, metaTop + 12, colWidth, 'Date Issued', formatDate(subscription.createdAt));
    drawField(
      doc,
      left + 15 + colWidth + 15,
      metaTop + 12,
      colWidth,
      'Billing Period',
      `${formatDate(subscription.startedAt)} - ${subscription.expiresAt ? formatDate(subscription.expiresAt) : 'No expiry'}`,
    );
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('STATUS', left + 15 + (colWidth + 15) * 2, metaTop + 12, { width: colWidth, characterSpacing: 0.3 });
    statusBadge(doc, left + 15 + (colWidth + 15) * 2, metaTop + 25, subscription.status);

    // --- From / Bill To -------------------------------------------------
    const partiesTop = metaTop + 56 + 25;
    const colGap = 30;
    const partyWidth = (right - left - colGap) / 2;

    doc.rect(left, partiesTop, 3, 40).fill(BRAND);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('FROM', left + 12, partiesTop, { characterSpacing: 0.3 });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('AdMobility', left + 12, partiesTop + 13);
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('Agent subscriptions & campaign platform', left + 12, doc.y + 2, { width: partyWidth - 12 });

    const billToX = left + partyWidth + colGap;
    doc.rect(billToX, partiesTop, 3, 40).fill(BRAND);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text('BILL TO', billToX + 12, partiesTop, { characterSpacing: 0.3 });
    const billTo = [
      subscription.agent.businessName || subscription.agent.name,
      subscription.agent.address,
      [subscription.agent.city, subscription.agent.state].filter(Boolean).join(', ') || null,
      subscription.agent.country,
      subscription.agent.taxId ? `Tax ID: ${subscription.agent.taxId}` : null,
      subscription.agent.phone,
      subscription.agent.email,
    ].filter((line): line is string => !!line);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(billTo[0] ?? '—', billToX + 12, partiesTop + 13, { width: partyWidth - 12 });
    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    let billY = doc.y + 2;
    for (const line of billTo.slice(1)) {
      doc.text(line, billToX + 12, billY, { width: partyWidth - 12 });
      billY = doc.y + 1;
    }

    // --- Line item table -------------------------------------------------
    const tableTop = Math.max(partiesTop + 60, billY + 15);
    doc.rect(left, tableTop, right - left, 24).fill(BRAND_SOFT);
    doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND);
    doc.text('DESCRIPTION', left + 12, tableTop + 8, { width: 175 });
    doc.text('CYCLE', left + 195, tableTop + 8, { width: 85 });
    doc.text('PERIOD', left + 290, tableTop + 8, { width: 140 });
    doc.text('AMOUNT', right - 12 - 80, tableTop + 8, { width: 80, align: 'right' });

    const rowTop = tableTop + 24 + 12;
    const amount = subscription.amountPaid != null ? toMoneyString(subscription.amountPaid) : String(subscription.plan.price);
    const period = `${formatDate(subscription.startedAt)} - ${subscription.expiresAt ? formatDate(subscription.expiresAt) : 'No expiry'}`;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK);
    doc.text(subscription.plan.name, left + 12, rowTop, { width: 175 });
    const afterPlanNameY = doc.y;
    doc.font('Helvetica').fontSize(9).fillColor(MUTED);
    const { campaignLimit, campaignDurationHours } = effectiveEntitlement(subscription);
    doc.text(`Up to ${campaignLimit} campaigns - ${campaignDurationHours}h each`, left + 12, afterPlanNameY + 2, { width: 175 });

    doc.font('Helvetica').fontSize(9).fillColor(INK);
    doc.text(subscription.billingCycle ?? subscription.plan.billingCycle, left + 195, rowTop, { width: 85 });
    doc.text(period, left + 290, rowTop, { width: 140 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(`Rs ${amount}`, right - 12 - 80, rowTop, { width: 80, align: 'right' });

    const rowBottom = Math.max(doc.y, afterPlanNameY + 14) + 14;
    doc
      .moveTo(left, rowBottom)
      .lineTo(right, rowBottom)
      .strokeColor(LINE)
      .lineWidth(1)
      .stroke();

    // --- Total banner -------------------------------------------------
    const totalTop = rowBottom + 14;
    const totalBoxWidth = 200;
    doc.roundedRect(right - totalBoxWidth, totalTop, totalBoxWidth, 40, 6).fill(BRAND);
    doc.font('Helvetica').fontSize(9).fillColor('#e4e1fb').text('TOTAL AMOUNT', right - totalBoxWidth + 15, totalTop + 8);
    doc.font('Helvetica-Bold').fontSize(15).fillColor('#fff').text(`Rs ${amount}`, right - totalBoxWidth + 15, totalTop + 20, { width: totalBoxWidth - 30, align: 'right' });

    // --- Extra detail: what the plan includes -------------------------
    const features = planFeatures(subscription.plan);
    let afterExtrasY = totalTop + 40 + 25;
    if (features.length > 0) {
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text('This plan includes', left, afterExtrasY);
      afterExtrasY = doc.y + 6;
      doc.font('Helvetica').fontSize(9).fillColor(MUTED);
      for (const feature of features) {
        doc.circle(left + 3, afterExtrasY + 4, 1.5).fill(BRAND);
        doc.fillColor(MUTED).text(feature, left + 12, afterExtrasY, { width: right - left - 12 });
        afterExtrasY = doc.y + 4;
      }
    }

    // --- Footer -------------------------------------------------
    doc
      .moveTo(left, 760)
      .lineTo(right, 760)
      .strokeColor(LINE)
      .stroke();
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .fillColor(INK)
      .text('Thank you for choosing AdMobility.', left, 770, { width: right - left, align: 'center' });
    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor(MUTED)
      .text('This is a system-generated receipt and does not require a signature. For billing questions, contact your AdMobility administrator.', left, 784, {
        width: right - left,
        align: 'center',
      });

    doc.end();
  });
}
