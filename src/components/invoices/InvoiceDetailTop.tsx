import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { FileText, IndianRupee, Truck, Wallet } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { homePathForRole } from '../../types';

export type InvoiceDetailSection = 'invoice' | 'payments' | 'logistic' | 'qc';

const QC_ICON_SRC = '/icons/qc-checked.png';

const SECTIONS: Array<{
  id: InvoiceDetailSection;
  label: string;
  icon: React.ReactNode;
  tone: string;
}> = [
  {
    id: 'invoice',
    label: 'Invoice',
    icon: <FileText size={28} strokeWidth={1.75} aria-hidden />,
    tone: 'blue',
  },
  {
    id: 'payments',
    label: 'Payments',
    icon: (
      <span className="invoice-detail-top__wallet-icon" aria-hidden>
        <Wallet size={24} strokeWidth={1.75} />
        <IndianRupee size={11} strokeWidth={2.5} />
      </span>
    ),
    tone: 'purple',
  },
  {
    id: 'logistic',
    label: 'Logistic',
    icon: <Truck size={28} strokeWidth={1.75} aria-hidden />,
    tone: 'orange',
  },
  {
    id: 'qc',
    label: 'QC',
    icon: (
      <img
        src={QC_ICON_SRC}
        alt=""
        className="invoice-detail-top__qc-icon"
        width={48}
        height={48}
        draggable={false}
      />
    ),
    tone: 'qc',
  },
];

function parseActiveSection(pathname: string): InvoiceDetailSection {
  if (pathname.endsWith('/payments')) return 'payments';
  if (pathname.endsWith('/logistic')) return 'logistic';
  if (pathname.endsWith('/qc')) return 'qc';
  return 'invoice';
}

export const InvoiceDetailTop: React.FC<{
  invoiceId: string;
  showQc?: boolean;
  qcCount?: number;
  qcRequired?: number;
}> = ({
  invoiceId,
  showQc = false,
  qcCount = 0,
  qcRequired = 5,
}) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const base = user ? homePathForRole(user.role) : '/dealer';
  const active = parseActiveSection(pathname);
  const sections = SECTIONS.filter(section => section.id !== 'qc' || showQc);

  return (
    <div className="invoice-detail-top">
      <div className="invoice-detail-top__actions" role="tablist" aria-label="Invoice sections">
        {sections.map(section => (
          <button
            key={section.id}
            type="button"
            role="tab"
            aria-selected={active === section.id}
            className={`invoice-detail-top__card invoice-detail-top__card--${section.tone} ${active === section.id ? 'is-active' : ''}`}
            onClick={() => {
              if (section.id === 'invoice') {
                navigate(`${base}/invoices/${invoiceId}/invoice/view?fresh=${Date.now()}`);
                return;
              }
              navigate(`${base}/invoices/${invoiceId}/${section.id}`);
            }}
          >
            <span className="invoice-detail-top__card-icon">{section.icon}</span>
            <span className="invoice-detail-top__card-label">{section.label}</span>
            {section.id === 'qc' ? (
              <span className="invoice-detail-top__card-sub">{qcCount}/{qcRequired}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
};
