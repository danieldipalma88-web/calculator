import BusinessWonJobsView from "./view";

export const dynamic = "force-dynamic";

export default async function BusinessWonJobsPage({ searchParams }: {
  searchParams: Promise<{ businessId?: string; as?: string }>;
}) {
  const params = await searchParams;
  return <BusinessWonJobsView key={`${params.businessId}|${params.as}`} businessId={params.businessId || ""} viewingEmail={params.as || ""} />;
}
