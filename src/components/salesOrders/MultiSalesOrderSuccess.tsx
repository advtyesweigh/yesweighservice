import React from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { formatCurrency } from '../../lib/catalog';
import type { SegmentSalesOrderResult } from '../../lib/dealerOrders';

type Props = {
  salesOrders: SegmentSalesOrderResult[];
  detailBasePath: string;
  listPath: string;
  shareToWa?: string;
  onDone?: () => void;
};

export const MultiSalesOrderSuccess: React.FC<Props> = ({
  salesOrders,
  detailBasePath,
  listPath,
  shareToWa,
  onDone,
}) => {
  const shareQs = shareToWa ? `?shareToWa=${encodeURIComponent(shareToWa)}` : '';
  const count = salesOrders.length;
  return (
    <div className="panel glass multi-so-success" role="status">
      <div className="multi-so-success__header">
        <CheckCircle2 size={22} aria-hidden />
        <div>
          <h2 className="multi-so-success__title">
            {count === 1 ? 'Sales order created' : `${count} sales orders created`}
          </h2>
          <p className="text-muted text-sm">
            Items were split by order type and branch (Cochin / Head Office) where needed.
          </p>
        </div>
      </div>
      <ul className="multi-so-success__list">
        {salesOrders.map(so => (
          <li key={so.zohoSalesOrderId} className="multi-so-success__item">
            <div>
              <strong>{so.bucketLabel || so.segmentLabel}</strong>
              <p className="text-muted text-sm">
                {so.zohoSalesOrderNumber || so.orderNumber}
                {so.branchLabel ? ` · ${so.branchLabel}` : ''}
                {so.salespersonName ? ` · ${so.salespersonName}` : ''}
                {' · '}
                {formatCurrency(so.subtotal)}
                {so.segment === 'software' || so.yesOneStage === 'ready_for_payment'
                  ? ' · Payment due'
                  : ''}
              </p>
            </div>
            <Link
              className="btn btn-secondary btn-sm"
              to={`${detailBasePath}/${so.zohoSalesOrderId}${shareQs}`}
            >
              Open
            </Link>
          </li>
        ))}
      </ul>
      <div className="multi-so-success__actions">
        {count === 1 && salesOrders[0] ? (
          <Link
            className="btn btn-primary"
            to={`${detailBasePath}/${salesOrders[0].zohoSalesOrderId}${shareQs}`}
          >
            View sales order
          </Link>
        ) : null}
        <Link className="btn btn-secondary" to={listPath} onClick={onDone}>
          All sales orders
        </Link>
      </div>
    </div>
  );
};
