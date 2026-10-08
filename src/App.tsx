import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { CartProvider } from './context/CartProvider';
import { DealerPriceLevelProvider } from './context/DealerPriceLevelProvider';
import { CartFlyProvider } from './context/CartFlyProvider';
import { ConfirmProvider } from './context/ConfirmContext';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Login } from './pages/Login';
import { DealerLogin } from './pages/DealerLogin';
import { SuperAdminDashboard } from './pages/admin/SuperAdminDashboard';
import { SalesByStatePage } from './pages/admin/SalesByStatePage';
import { StaffDashboard } from './pages/staff/StaffDashboard';
import { HrLayout } from './pages/hr/HrLayout';
import { HrStaffListPage } from './pages/hr/HrStaffListPage';
import { HrStaffDetailPage } from './pages/hr/HrStaffDetailPage';
import { HrStaffFormPage } from './pages/hr/HrStaffFormPage';
import { HrMyProfilePage } from './pages/hr/HrMyProfilePage';
import { HrSuperAdminsPage } from './pages/hr/HrSuperAdminsPage';
import { HrRolesPage } from './pages/hr/HrRolesPage';
import { HrWorkReportPage } from './pages/hr/HrWorkReportPage';
import { HrHolidayCalendarPage } from './pages/hr/HrHolidayCalendarPage';
import { HrSalaryCalculationPage } from './pages/hr/HrSalaryCalculationPage';
import { HrWarehousePage } from './pages/hr/HrWarehousePage';
import { HrMediaPage } from './pages/hr/HrMediaPage';
import { HrSpareInchargePage } from './pages/hr/HrSpareInchargePage';
import { MediaHomePage } from './pages/media/MediaHomePage';
import { AdminDealersList } from './pages/admin/AdminDealersList';
import { AdminDealerAccountsList } from './pages/admin/AdminDealerAccountsList';
import { AdminDealerStaffList } from './pages/admin/AdminDealerStaffList';
import { AdminInvoicesPage } from './pages/admin/AdminInvoicesPage';
import { AdminInvoiceSyncPage } from './pages/admin/AdminInvoiceSyncPage';
import { AdminInvoiceDetailLayout } from './pages/admin/AdminInvoiceDetailLayout';
import { AdminInvoiceDocumentPage } from './pages/admin/AdminInvoiceDocumentPage';
import { AdminInvoicePdfViewerPage } from './pages/admin/AdminInvoicePdfViewerPage';
import { AdminPurchaseOrdersPage } from './pages/admin/AdminPurchaseOrdersPage';
import { AdminCreatePurchaseOrderPage } from './pages/admin/AdminCreatePurchaseOrderPage';
import { AdminPurchaseOrderDetailLayout } from './pages/admin/AdminPurchaseOrderDetailLayout';
import { AdminPurchaseOrderDocumentPage } from './pages/admin/AdminPurchaseOrderDocumentPage';
import { AdminGoodsReceiptsPage } from './pages/admin/AdminGoodsReceiptsPage';
import { AdminGoodsReceiptDetailLayout } from './pages/admin/AdminGoodsReceiptDetailLayout';
import { AdminGoodsReceiptDocumentPage } from './pages/admin/AdminGoodsReceiptDocumentPage';
import { AdminSpareIndentsPage } from './pages/admin/AdminSpareIndentsPage';
import { AdminUnifiedSalesOrdersPage } from './pages/admin/AdminUnifiedSalesOrdersPage';
import { AdminSalesOrderDetailLayout } from './pages/admin/AdminSalesOrderDetailLayout';
import { AdminSalesOrderDocumentPage } from './pages/admin/AdminSalesOrderDocumentPage';
import { AdminSalesOrderPdfViewerPage } from './pages/admin/AdminSalesOrderPdfViewerPage';
import { StaffOrderDetailPage } from './pages/staff/StaffOrderDetailPage';
import { StaffCreateSalesOrderPage } from './pages/staff/StaffCreateSalesOrderPage';
import { DealerMenuPages } from './pages/dealer/DealerPages';
import { DealerTeamPage } from './pages/dealer/DealerTeamPage';
import { ProfilePage } from './pages/shared/ProfilePage';
import { SettingsLayout } from './pages/admin/SettingsLayout';
import { ReportsLayout } from './pages/admin/ReportsLayout';
import { SettingsProfileTab } from './pages/admin/settings/SettingsProfileTab';
import { WarehouseLocationsTab } from './pages/admin/settings/WarehouseLocationsTab';
import { StoreRoomTab } from './pages/admin/settings/StoreRoomTab';
import { ProductSettingsTab } from './pages/admin/settings/ProductSettingsTab';
import { SanoftSettingsTab } from './pages/admin/settings/SanoftSettingsTab';
import { SerialNumberAllotmentTab } from './pages/admin/settings/SerialNumberAllotmentTab';
import { SkuCorrectionTab } from './pages/admin/settings/SkuCorrectionTab';
import { LogisticsSettingsTab } from './pages/admin/settings/LogisticsSettingsTab';
import { LocalPrintersTab } from './pages/admin/settings/LocalPrintersTab';
import { IntegrationsSettingsTab } from './pages/admin/settings/IntegrationsSettingsTab';
import { WebhookSettingsTab } from './pages/admin/settings/WebhookSettingsTab';
import { RcDetailsTab } from './pages/admin/settings/RcDetailsTab';
import { YesGatcCertificatesPage } from './pages/admin/YesGatcCertificatesPage';
import { DealerLevelDefinitionsPanel } from './components/dealers/DealerLevelDefinitionsPanel';
import { AuditCyclesTab } from './pages/admin/settings/AuditCyclesTab';
import { AuditReportTab } from './pages/admin/settings/AuditReportTab';
import { GatcReportTab } from './pages/admin/settings/GatcReportTab';
import { IncentiveReportTab } from './pages/admin/settings/IncentiveReportTab';
import { RcOvReportTab } from './pages/admin/settings/RcOvReportTab';
import { WhatsAppInboxPage } from './pages/admin/WhatsAppInboxPage';
import { PhonePage } from './pages/admin/PhonePage';
import { InventoryAuditItemPage } from './pages/admin/InventoryAuditItemPage';
import { InventoryAuditLinkedGroupPage } from './pages/admin/InventoryAuditLinkedGroupPage';
import { OpenCatalogPage } from './pages/public/OpenCatalogPage';
import { HrSalaryPublicSharePage } from './pages/public/HrSalaryPublicSharePage';
import { HrWorklogPublicSharePage } from './pages/public/HrWorklogPublicSharePage';
import { ProductDetailPage } from './pages/ProductDetailPage';
import { SpareProductMapPage } from './pages/SpareProductMapPage';
import {
  LegacyCatalogMapRedirect,
  LegacyCatalogProductDetailRedirect,
  LegacyCatalogRootRedirect,
  LegacyCatalogSpareDetailRedirect,
  LegacySpareDetailRedirect,
  LegacySpareMapRedirect,
} from './components/catalog/LegacyCatalogRedirects';
import { WarehouseHomePage } from './pages/warehouse/WarehouseHomePage';
import { WarehouseLayout } from './pages/warehouse/WarehouseLayout';
import { canAccessNavFeature, canViewHr, canViewPurchaseOrders } from './lib/staffAccess';
import { landingPathForRole } from './types';

const LegacyPathRedirect: React.FC<{ from: string; to: string }> = ({ from, to }) => {
  const { pathname } = useLocation();
  return <Navigate to={pathname.replace(from, to)} replace />;
};

const SuperAdminPurchaseOrderRoute: React.FC = () => {
  const { user } = useAuth();
  if (!canViewPurchaseOrders(user)) {
    return <Navigate to={user ? landingPathForRole(user.role) : '/login'} replace />;
  }
  return <Outlet />;
};

const StaffProfileEntry: React.FC = () => {
  const { user } = useAuth();
  if (user && (canViewHr(user) || canAccessNavFeature(user, 'training'))) {
    return <Navigate to="/staff/settings/profile" replace />;
  }
  return <ProfilePage />;
};

const OpsOrderDetailRedirect: React.FC = () => {
  const { pathname } = useLocation();
  const base = pathname.startsWith('/staff') ? '/staff' : '/super-admin';
  return <Navigate to={`${base}/sales-orders`} replace />;
};

const OpsOrdersListRedirect: React.FC = () => {
  const { pathname } = useLocation();
  const base = pathname.startsWith('/staff') ? '/staff' : '/super-admin';
  return <Navigate to={`${base}/sales-orders`} replace />;
};

const catalogRoutes = (
  <>
    <Route path="products" element={<DealerMenuPages.Products />} />
    <Route path="products/inventory-audit/linked/:catalogProductId" element={<InventoryAuditLinkedGroupPage />} />
    <Route path="products/inventory-audit/:itemId" element={<InventoryAuditItemPage />} />
    <Route path="products/map/:productId" element={<SpareProductMapPage />} />
    <Route path="products/spare/:productId" element={<ProductDetailPage />} />
    <Route path="products/:productId" element={<ProductDetailPage />} />
    {/* Legacy /catalog → /products */}
    <Route path="catalog" element={<LegacyCatalogRootRedirect />} />
    <Route path="catalog/inventory-audit/linked/:catalogProductId" element={<LegacyCatalogRootRedirect />} />
    <Route path="catalog/inventory-audit/:itemId" element={<LegacyCatalogRootRedirect />} />
    <Route path="catalog/map/:productId" element={<LegacyCatalogMapRedirect />} />
    <Route path="catalog/spare/:productId" element={<LegacyCatalogSpareDetailRedirect />} />
    <Route path="catalog/:productId" element={<LegacyCatalogProductDetailRedirect />} />
    <Route path="spares" element={<Navigate to="products?section=spares" replace />} />
    <Route path="spares/product/:productId" element={<LegacySpareMapRedirect />} />
    <Route path="spares/:productId" element={<LegacySpareDetailRedirect />} />
  </>
);

const superAdminOpsRoutes = (
  <>
    <Route path="warranty-support" element={<DealerMenuPages.WarrantySupport />} />
    <Route path="warranty-support/complaint-guidelines" element={<DealerMenuPages.ComplaintGuidelines />} />
    <Route path="warranty-support/:requestId" element={<DealerMenuPages.SupportRequestDetail />} />
    <Route path="verification" element={<DealerMenuPages.Verification />} />
    <Route path="advertisements" element={<DealerMenuPages.Advertisements />} />
    <Route path="logistics" element={<DealerMenuPages.Logistics />} />
    <Route path="loyalty" element={<DealerMenuPages.Loyalty />} />
    <Route path="notifications" element={<DealerMenuPages.Notifications />} />
    <Route path="ai-assistant" element={<DealerMenuPages.AiAssistant />} />
  </>
);

const dealerInvoiceRoutes = (
  <>
    <Route path="invoices" element={<DealerMenuPages.Invoices />} />
    <Route path="invoices/:invoiceId" element={<DealerMenuPages.InvoiceDetail />}>
      <Route index element={<Navigate to="invoice" replace />} />
      <Route path="invoice">
        <Route index element={<DealerMenuPages.InvoiceDocument />} />
        <Route path="view" element={<DealerMenuPages.InvoicePdfViewer />} />
      </Route>
      <Route path="payments" element={<DealerMenuPages.InvoicePayments />} />
      <Route path="logistic" element={<DealerMenuPages.InvoiceLogistic />} />
      <Route path="qc" element={<DealerMenuPages.InvoiceQc />} />
    </Route>
  </>
);

/** Staff invoices — same org list/detail as super admin, scoped to their Zoho salesperson ids. */
const staffInvoiceRoutes = (
  <>
    <Route path="invoices" element={<AdminInvoicesPage />} />
    <Route path="invoices/:customerId/:invoiceId" element={<AdminInvoiceDetailLayout />}>
      <Route index element={<Navigate to="invoice" replace />} />
      <Route path="invoice">
        <Route index element={<AdminInvoiceDocumentPage />} />
        <Route path="view" element={<AdminInvoicePdfViewerPage />} />
      </Route>
    </Route>
  </>
);

/** Staff goods receipts — same as super admin; gated by invoices.view in nav. */
const staffGoodsReceiptRoutes = (
  <>
    <Route path="goods-receipts" element={<AdminGoodsReceiptsPage />} />
    <Route path="goods-receipts/sync" element={<Navigate to="/staff/goods-receipts" replace />} />
    <Route path="goods-receipts/:goodsReceiptId" element={<AdminGoodsReceiptDetailLayout />}>
      <Route index element={<AdminGoodsReceiptDocumentPage />} />
      <Route path="view" element={<Navigate to=".." replace />} />
    </Route>
  </>
);

const portalMenuRoutes = (
  <>
    <Route path="warranty-support" element={<DealerMenuPages.WarrantySupport />} />
    <Route path="warranty-support/complaint-guidelines" element={<DealerMenuPages.ComplaintGuidelines />} />
    <Route path="warranty-support/:requestId" element={<DealerMenuPages.SupportRequestDetail />} />
    {catalogRoutes}
    <Route path="verification" element={<Navigate to="products" replace />} />
    <Route path="advertisements" element={<DealerMenuPages.Advertisements />} />
    <Route path="logistics" element={<DealerMenuPages.Logistics />} />
    <Route path="loyalty" element={<DealerMenuPages.Loyalty />} />
    <Route path="notifications" element={<DealerMenuPages.Notifications />} />
    <Route path="ai-assistant" element={<DealerMenuPages.AiAssistant />} />
  </>
);

const dealerSalesOrderRoutes = (
  <>
    <Route path="sales-orders" element={<DealerMenuPages.SalesOrders />} />
    <Route path="sales-orders/portal/:orderId" element={<Navigate to="../" relative="path" replace />} />
    <Route path="sales-orders/:salesOrderId" element={<AdminSalesOrderDetailLayout />}>
      <Route index element={<AdminSalesOrderDocumentPage />} />
      <Route path="view" element={<AdminSalesOrderPdfViewerPage />} />
    </Route>
    <Route path="orders" element={<DealerMenuPages.Orders />} />
    <Route path="orders/history" element={<DealerMenuPages.OrderHistory />} />
    <Route path="orders/:orderId" element={<Navigate to="../sales-orders" relative="path" replace />} />
  </>
);

const dealerRoutes = (
  <>
    <Route index element={<Navigate to="products" replace />} />
    {portalMenuRoutes}
    <Route path="reports" element={<DealerMenuPages.Reports />} />
    <Route path="price-list" element={<DealerMenuPages.PriceList />} />
    <Route path="training" element={<DealerMenuPages.Training />} />
    {dealerInvoiceRoutes}
    {dealerSalesOrderRoutes}
    <Route path="team" element={<DealerTeamPage />} />
    <Route path="profile" element={<ProfilePage />} />
  </>
);

function hrNestedRoutes(settingsBase: string, includeAdminExtras: boolean) {
  return (
    <Route path="hr" element={<HrLayout basePath={settingsBase} />}>
      <Route path="staff" element={<HrStaffListPage basePath={settingsBase} />} />
      <Route path="staff/new" element={<HrStaffFormPage basePath={settingsBase} />} />
      <Route path="staff/:uid" element={<HrStaffDetailPage basePath={settingsBase} />} />
      <Route path="staff/:uid/edit" element={<HrStaffFormPage basePath={settingsBase} />} />
      <Route path="report" element={<HrWorkReportPage basePath={settingsBase} />} />
      <Route path="holidays" element={<HrHolidayCalendarPage />} />
      <Route path="salary" element={<HrSalaryCalculationPage basePath={settingsBase} />} />
      {includeAdminExtras ? (
        <>
          <Route path="super-admins" element={<HrSuperAdminsPage basePath={settingsBase} />} />
          <Route path="roles" element={<HrRolesPage />} />
        </>
      ) : null}
      <Route path="warehouse" element={<HrWarehousePage basePath={settingsBase} />} />
      <Route path="media" element={<HrMediaPage basePath={settingsBase} />} />
      <Route path="spare-incharge" element={<HrSpareInchargePage basePath={settingsBase} />} />
      <Route path="me" element={<HrMyProfilePage />} />
    </Route>
  );
}

function AdminPhoneRedirect() {
  const location = useLocation();
  return <Navigate to={{ pathname: '/super-admin/phone', search: location.search }} replace />;
}

const App: React.FC = () => (
  <AuthProvider>
    <DealerPriceLevelProvider>
    <CartProvider>
    <CartFlyProvider>
    <ConfirmProvider>
      <Router>
        <Routes>
          <Route path="/" element={<Navigate to="/signup" replace />} />
          <Route path="/signup" element={<DealerLogin />} />
          <Route path="/login" element={<Login />} />
          {/* Legacy bookmark — warehouse staff use main /login and are routed by role. */}
          <Route path="/warehouse-login" element={<Navigate to="/login" replace />} />
          <Route path="/dealer-login" element={<DealerLogin />} />
          <Route path="/oc" element={<OpenCatalogPage />} />
          <Route path="/oc/:productId" element={<ProductDetailPage />} />
          <Route path="/s/salary/:token" element={<HrSalaryPublicSharePage />} />
          <Route path="/s/worklog/:token" element={<HrWorklogPublicSharePage />} />
          <Route path="/admin/phone" element={<AdminPhoneRedirect />} />
          <Route path="/admin/*" element={<Navigate to="/super-admin" replace />} />
          <Route path="/director-staff/*" element={<LegacyPathRedirect from="/director-staff" to="/dealer-staff" />} />
          <Route path="/director/*" element={<LegacyPathRedirect from="/director" to="/dealer" />} />
          <Route path="/super-admin/directors/*" element={<Navigate to="/super-admin/dealers" replace />} />
          <Route path="/super-admin/director-staff/*" element={<Navigate to="/super-admin/dealers" replace />} />
          <Route path="/staff/directors/*" element={<Navigate to="/staff/dealers" replace />} />
          <Route path="/staff/director-staff/*" element={<Navigate to="/staff/dealers" replace />} />

          <Route element={<ProtectedRoute allowedRoles={['super_admin']} loginPath="/login" />}>
            <Route path="/super-admin" element={<Layout />}>
              <Route index element={<SuperAdminDashboard />} />
              <Route path="sales-by-state" element={<SalesByStatePage />} />
              {catalogRoutes}
              <Route path="staff" element={<Navigate to="/super-admin/settings/hr/staff" replace />} />
              <Route path="super-admins" element={<Navigate to="/super-admin/settings/hr/super-admins" replace />} />
              <Route path="dealers/*" element={<AdminDealersList />} />
              <Route path="certificate" element={<YesGatcCertificatesPage />} />
              <Route path="hr/dealers/*" element={<LegacyPathRedirect from="/super-admin/hr/dealers" to="/super-admin/dealers" />} />
              <Route path="hr/*" element={<LegacyPathRedirect from="/super-admin/hr" to="/super-admin/settings/hr" />} />
              <Route path="dealer-staff" element={<AdminDealerStaffList />} />
              <Route path="training" element={<Navigate to="/super-admin/settings/training" replace />} />
              <Route path="dealer-accounts" element={<AdminDealerAccountsList />} />
              <Route path="invoices" element={<AdminInvoicesPage />} />
              <Route path="invoices/:customerId/:invoiceId" element={<AdminInvoiceDetailLayout />}>
                <Route index element={<Navigate to="invoice" replace />} />
                <Route path="invoice">
                  <Route index element={<AdminInvoiceDocumentPage />} />
                  <Route path="view" element={<AdminInvoicePdfViewerPage />} />
                </Route>
              </Route>
              <Route path="invoices/import" element={<AdminInvoiceSyncPage />} />
              <Route path="invoices/sync" element={<Navigate to="/super-admin/invoices/import" replace />} />
              <Route path="sales-orders" element={<AdminUnifiedSalesOrdersPage />} />
              <Route path="sales-orders/new" element={<StaffCreateSalesOrderPage />} />
              <Route path="sales-orders/sync" element={<Navigate to="/super-admin/sales-orders" replace />} />
              <Route path="sales-orders/portal/:orderId" element={<StaffOrderDetailPage />} />
              <Route path="sales-orders/:salesOrderId" element={<AdminSalesOrderDetailLayout />}>
                <Route index element={<AdminSalesOrderDocumentPage />} />
                <Route path="view" element={<AdminSalesOrderPdfViewerPage />} />
              </Route>
              <Route path="orders" element={<OpsOrdersListRedirect />} />
              <Route path="orders/history" element={<OpsOrdersListRedirect />} />
              <Route path="orders/:orderId" element={<OpsOrderDetailRedirect />} />
              <Route element={<SuperAdminPurchaseOrderRoute />}>
                <Route path="purchase-orders" element={<AdminPurchaseOrdersPage />} />
                <Route path="purchase-orders/new" element={<AdminCreatePurchaseOrderPage />} />
                <Route path="purchase-orders/sync" element={<Navigate to="/super-admin/purchase-orders" replace />} />
                <Route path="purchase-orders/:purchaseOrderId" element={<AdminPurchaseOrderDetailLayout />}>
                  <Route index element={<AdminPurchaseOrderDocumentPage />} />
                  <Route path="view" element={<Navigate to=".." replace />} />
                </Route>
              </Route>
              <Route path="goods-receipts" element={<AdminGoodsReceiptsPage />} />
              <Route path="goods-receipts/sync" element={<Navigate to="/super-admin/goods-receipts" replace />} />
              <Route path="goods-receipts/:goodsReceiptId" element={<AdminGoodsReceiptDetailLayout />}>
                <Route index element={<AdminGoodsReceiptDocumentPage />} />
                <Route path="view" element={<Navigate to=".." replace />} />
              </Route>
              <Route path="spare-indents" element={<AdminSpareIndentsPage />} />
              {superAdminOpsRoutes}
              <Route path="reports" element={<ReportsLayout basePath="/super-admin" />}>
                <Route path="audit-report" element={<AuditReportTab />} />
                <Route path="gatc-report" element={<GatcReportTab />} />
                <Route path="rc-ov-report" element={<RcOvReportTab />} />
                <Route path="incentive-report" element={<IncentiveReportTab />} />
              </Route>
              <Route path="whatsapp" element={<WhatsAppInboxPage />} />
              <Route path="phone" element={<PhonePage />} />
              <Route path="cloud-call" element={<Navigate to="/super-admin/phone" replace />} />
              <Route path="settings" element={<SettingsLayout />}>
                <Route path="profile" element={<SettingsProfileTab />} />
                {hrNestedRoutes('/super-admin/settings', true)}
                <Route path="training" element={<DealerMenuPages.Training />} />
                <Route path="warehouse" element={<WarehouseLocationsTab />} />
                <Route path="store-room" element={<StoreRoomTab />} />
                <Route path="audit-cycles" element={<AuditCyclesTab />} />
                <Route
                  path="audit-report"
                  element={<Navigate to="/super-admin/reports/audit-report" replace />}
                />
                <Route path="product" element={<ProductSettingsTab />} />
                <Route path="price-level" element={<DealerLevelDefinitionsPanel />} />
                <Route
                  path="price-levels"
                  element={<Navigate to="/super-admin/settings/price-level" replace />}
                />
                <Route path="sanoft" element={<SanoftSettingsTab />} />
                <Route path="serial-numbers" element={<SerialNumberAllotmentTab />} />
                <Route path="sku-correction" element={<SkuCorrectionTab />} />
                <Route path="logistics" element={<LogisticsSettingsTab />} />
                <Route path="local-printers" element={<LocalPrintersTab />} />
                <Route path="integration" element={<IntegrationsSettingsTab />} />
                <Route path="webhook" element={<WebhookSettingsTab />} />
                <Route path="rc-details" element={<RcDetailsTab />} />
              </Route>
              <Route path="profile" element={<Navigate to="/super-admin/settings/profile" replace />} />
            </Route>
          </Route>

          <Route element={<ProtectedRoute allowedRoles={['staff']} loginPath="/login" />}>
            <Route path="/staff" element={<Layout />}>
              <Route index element={<StaffDashboard />} />
              <Route path="tasks" element={<DealerMenuPages.Tasks />} />
              {portalMenuRoutes}
              {staffInvoiceRoutes}
              {staffGoodsReceiptRoutes}
              <Route path="spare-indents" element={<AdminSpareIndentsPage />} />
              <Route path="leads" element={<DealerMenuPages.Leads />} />
              <Route path="dealers/*" element={<AdminDealersList />} />
              <Route path="certificate" element={<YesGatcCertificatesPage />} />
              <Route path="sales-orders" element={<AdminUnifiedSalesOrdersPage />} />
              <Route path="sales-orders/new" element={<StaffCreateSalesOrderPage />} />
              <Route path="sales-orders/portal/:orderId" element={<StaffOrderDetailPage />} />
              <Route path="sales-orders/:salesOrderId" element={<AdminSalesOrderDetailLayout />}>
                <Route index element={<AdminSalesOrderDocumentPage />} />
                <Route path="view" element={<AdminSalesOrderPdfViewerPage />} />
              </Route>
              <Route path="orders" element={<OpsOrdersListRedirect />} />
              <Route path="orders/history" element={<OpsOrdersListRedirect />} />
              <Route path="orders/:orderId" element={<OpsOrderDetailRedirect />} />
              <Route path="purchase-orders/*" element={<Navigate to="/staff" replace />} />
              <Route path="reports" element={<ReportsLayout basePath="/staff" />}>
                <Route path="audit-report" element={<AuditReportTab />} />
                <Route path="gatc-report" element={<GatcReportTab />} />
                <Route path="rc-ov-report" element={<RcOvReportTab />} />
                <Route path="incentive-report" element={<IncentiveReportTab />} />
              </Route>
              <Route path="hr/*" element={<LegacyPathRedirect from="/staff/hr" to="/staff/settings/hr" />} />
              <Route path="training" element={<Navigate to="/staff/settings/training" replace />} />
              <Route path="settings" element={<SettingsLayout />}>
                <Route path="profile" element={<SettingsProfileTab />} />
                {hrNestedRoutes('/staff/settings', false)}
                <Route path="training" element={<DealerMenuPages.Training />} />
                <Route path="price-level" element={<DealerLevelDefinitionsPanel />} />
                <Route path="rc-details" element={<RcDetailsTab />} />
              </Route>
              <Route path="profile" element={<StaffProfileEntry />} />
            </Route>
          </Route>

          <Route element={<ProtectedRoute allowedRoles={['media']} loginPath="/login" />}>
            <Route path="/media" element={<Layout />}>
              <Route index element={<MediaHomePage />} />
              {catalogRoutes}
              <Route path="profile" element={<ProfilePage />} />
            </Route>
          </Route>

          <Route element={<ProtectedRoute allowedRoles={['dealer']} />}>
            <Route path="/dealer" element={<Layout />}>
              {dealerRoutes}
            </Route>
          </Route>

          <Route element={<ProtectedRoute allowedRoles={['warehouse']} loginPath="/login" />}>
            <Route path="/warehouse" element={<WarehouseLayout />}>
              <Route index element={<WarehouseHomePage />} />
              <Route path="*" element={<Navigate to="/warehouse" replace />} />
            </Route>
          </Route>

          <Route element={<ProtectedRoute allowedRoles={['dealer_staff']} />}>
            <Route path="/dealer-staff" element={<Layout />}>
              <Route index element={<Navigate to="products" replace />} />
              <Route path="warranty-support" element={<DealerMenuPages.WarrantySupport />} />
              <Route path="warranty-support/complaint-guidelines" element={<DealerMenuPages.ComplaintGuidelines />} />
              <Route path="warranty-support/:requestId" element={<DealerMenuPages.SupportRequestDetail />} />
              <Route path="reports" element={<DealerMenuPages.Reports />} />
              <Route path="price-list" element={<DealerMenuPages.PriceList />} />
              <Route path="invoices" element={<DealerMenuPages.Invoices />} />
              <Route path="invoices/:invoiceId" element={<DealerMenuPages.InvoiceDetail />}>
                <Route index element={<Navigate to="invoice" replace />} />
                <Route path="invoice">
                  <Route index element={<DealerMenuPages.InvoiceDocument />} />
                  <Route path="view" element={<DealerMenuPages.InvoicePdfViewer />} />
                </Route>
                <Route path="payments" element={<DealerMenuPages.InvoicePayments />} />
                <Route path="logistic" element={<DealerMenuPages.InvoiceLogistic />} />
                <Route path="qc" element={<DealerMenuPages.InvoiceQc />} />
              </Route>
              {catalogRoutes}
              {dealerSalesOrderRoutes}
              <Route path="verification" element={<Navigate to="products" replace />} />
              <Route path="advertisements" element={<DealerMenuPages.Advertisements />} />
              <Route path="logistics" element={<DealerMenuPages.Logistics />} />
              <Route path="loyalty" element={<DealerMenuPages.RewardPoint />} />
              <Route path="scheme" element={<DealerMenuPages.Scheme />} />
              <Route path="ai-assistant" element={<DealerMenuPages.AiAssistant />} />
              <Route path="training" element={<DealerMenuPages.Training />} />
              <Route path="notifications" element={<DealerMenuPages.Notifications />} />
              <Route path="team" element={<DealerTeamPage />} />
              <Route path="profile" element={<ProfilePage />} />
            </Route>
          </Route>

          <Route path="*" element={<Navigate to="/signup" replace />} />
        </Routes>
      </Router>
    </ConfirmProvider>
    </CartFlyProvider>
    </CartProvider>
    </DealerPriceLevelProvider>
  </AuthProvider>
);

export default App;
