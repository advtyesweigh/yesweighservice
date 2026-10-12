/** Cart line payload for Zoho sales-order submit. */

export interface SubmitDealerOrderLineInput {
  productId: string;
  quantity: number;
  /** Selected GATC stamping fee id; omit/null = without stamping. */
  gatcStampingPriceId?: string | null;
  /** Extra QC per machine; server adds the category fee to unit rate. */
  qcEnabled?: boolean;
  /** Staff only: base product rate (server adds GATC / QC fees). */
  rate?: number;
}
