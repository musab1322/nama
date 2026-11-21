import { ReportForm } from "@/app/report/[slug]/ReportForm";

/** /report/{slug}: public, no account needed (FR-013). Linked from every generated app's privacy page. */
export default async function ReportPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ReportForm slug={slug.toLowerCase().slice(0, 63)} />;
}
