import React from 'react';
import { PagePlaceholder } from '../../components/PagePlaceholder';
import { useAuth } from '../../context/AuthContext';
import { hideDealerStaffCommercials } from '../../lib/dealerAccess';
import { homePathForRole } from '../../types';
import { OrdersPage } from './OrdersPage';
import { Navigate } from 'react-router-dom';
import { DealerOrderDetailPage } from './DealerOrderDetailPage';
import { DealerSalesOrdersPage } from './DealerSalesOrdersPage';
import { CatalogPage } from './CatalogPage';
import { GatcVerificationEmbedPage } from './GatcVerificationEmbedPage';
import { InvoicesPage } from './InvoicesPage';
import { InvoiceDetailLayout } from './InvoiceDetailLayout';
import { InvoiceDocumentPage } from './InvoiceDocumentPage';
import { InvoicePdfViewerPage } from './InvoicePdfViewerPage';
import { InvoiceSectionPlaceholderPage } from './InvoiceSectionPlaceholderPage';
import { InvoiceQcPage } from './InvoiceQcPage';
import { WarrantySupportPage } from './WarrantySupportPage';
import { SupportRequestDetailPage } from './SupportRequestDetailPage';
import { ComplaintGuidelinesPage } from './ComplaintGuidelinesPage';
import { LogisticsPage } from './LogisticsPage';

function DealerInvoicesRoute() {
  const { user } = useAuth();
  if (hideDealerStaffCommercials(user) && user) {
    return <Navigate to={`${homePathForRole(user.role)}/sales-orders`} replace />;
  }
  if (user?.role === 'dealer' || user?.role === 'dealer_staff') {
    return <InvoicesPage />;
  }
  return (
    <PagePlaceholder
      title="Invoice"
      description="Create, send, and manage customer invoices and billing records."
    />
  );
}

function DealerInvoiceDetailRoute() {
  const { user } = useAuth();
  if (hideDealerStaffCommercials(user) && user) {
    return <Navigate to={`${homePathForRole(user.role)}/sales-orders`} replace />;
  }
  if (user?.role === 'dealer' || user?.role === 'dealer_staff') {
    return <InvoiceDetailLayout />;
  }
  return (
    <PagePlaceholder
      title="Invoice"
      description="Create, send, and manage customer invoices and billing records."
    />
  );
}

function OrderDetailRoute() {
  return <DealerOrderDetailPage />;
}

function OrderHistoryRoute() {
  const { user } = useAuth();
  if (user?.role === 'dealer' || user?.role === 'dealer_staff') {
    return <Navigate to={`${homePathForRole(user.role)}/sales-orders`} replace />;
  }
  return <OrdersPage />;
}

function SalesOrdersRoute() {
  const { user } = useAuth();
  if (user?.role === 'dealer' || user?.role === 'dealer_staff') {
    return <DealerSalesOrdersPage />;
  }
  return <Navigate to="/" replace />;
}

export const RoleDashboard: React.FC = () => {
  const { user } = useAuth();

  if (user?.role === 'dealer' || user?.role === 'dealer_staff') {
    return <Navigate to={`${homePathForRole(user.role)}/products`} replace />;
  }

  return (
    <div className="page-content fade-in">
      <div className="panel glass">
        <h2>Welcome, {user?.displayName}</h2>
        <p className="text-muted mt-4">
          YesOne Platform — your workspace for verification, quality, and
          customer operations under the YesOne brand.
        </p>
      </div>
    </div>
  );
};

export const DealerMenuPages = {
  WarrantySupport: WarrantySupportPage,
  SupportRequestDetail: SupportRequestDetailPage,
  ComplaintGuidelines: ComplaintGuidelinesPage,
  Invoices: DealerInvoicesRoute,
  InvoiceDetail: DealerInvoiceDetailRoute,
  InvoiceDocument: InvoiceDocumentPage,
  InvoicePdfViewer: InvoicePdfViewerPage,
  InvoicePayments: () => <InvoiceSectionPlaceholderPage section="payments" />,
  InvoiceLogistic: () => <InvoiceSectionPlaceholderPage section="logistic" />,
  InvoiceQc: InvoiceQcPage,
  Products: CatalogPage,
  Spares: CatalogPage,
  Catalog: CatalogPage,
  Orders: OrdersPage,
  OrderHistory: OrderHistoryRoute,
  OrderDetail: OrderDetailRoute,
  SalesOrders: SalesOrdersRoute,
  Verification: GatcVerificationEmbedPage,
  Advertisements: () => (
    <PagePlaceholder
      title="Media Center"
      description="Promotional content, dealership media assets, and campaign materials."
    />
  ),
  Logistics: LogisticsPage,
  Reports: () => (
    <PagePlaceholder
      title="Reports"
      description="Sales, support, and operational reports for your dealership."
    />
  ),
  PriceList: () => (
    <PagePlaceholder
      title="Price list"
      description="Dealer price list for products and spare parts."
    />
  ),
  Loyalty: () => (
    <PagePlaceholder
      title="Loyalty"
      description="Dealer loyalty points, rewards, and tier benefits."
    />
  ),
  RewardPoint: () => (
    <PagePlaceholder
      title="Reward point"
      description="Reward points for your dealership."
    />
  ),
  Scheme: () => (
    <PagePlaceholder
      title="Scheme"
      description="Dealer schemes and offers."
    />
  ),
  Training: () => (
    <PagePlaceholder
      title="Trainings"
      description="Assign and monitor staff training modules and certification progress."
    />
  ),
  Notifications: () => (
    <PagePlaceholder
      title="Notifications"
      description="Service alerts, renewal reminders, and operational updates."
    />
  ),
  AiAssistant: () => (
    <PagePlaceholder
      title="AI assistance"
      description="Your YesOne AI assistant for service guidance, documentation lookup, and operational support."
    />
  ),
  Leads: () => (
    <PagePlaceholder
      title="Leads"
      description="Track sales leads, inquiries, and follow-ups across dealers and regions."
    />
  ),
  Tasks: () => (
    <PagePlaceholder
      title="Tasks"
      description="Assign, track, and complete daily work items across your team."
    />
  ),
};
