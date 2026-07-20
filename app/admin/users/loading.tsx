export default function AdminLoading() {
  return (
    <div className="page-loading-overlay" aria-busy="true" aria-live="polite">
      <div className="page-loading-panel">
        <span className="page-loading-spinner" aria-hidden="true" />
        <strong>Loading Platform Admin...</strong>
        <span>Please wait while the latest information is loaded.</span>
      </div>
    </div>
  );
}
