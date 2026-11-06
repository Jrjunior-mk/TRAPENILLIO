"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Suspense } from "react";
import { AdminPortal } from "@/components/portals/admin";
import { KpaPortal, KraPortal, NtsaPortal } from "@/components/portals/agencies";
import { KenhaPortal } from "@/components/portals/kenha";
import { LoaderPortal } from "@/components/portals/loader";
import { TransporterPortal } from "@/components/portals/transporter";
import { ErrorBox, Loading } from "@/components/ui";

const VIEWS: Record<string, () => React.ReactNode> = {
  kenha: KenhaPortal,
  kpa: KpaPortal,
  kra: KraPortal,
  ntsa: NtsaPortal,
  transporter: TransporterPortal,
  loader: LoaderPortal,
  admin: AdminPortal,
};

function AgencyView() {
  const { agency } = useParams<{ agency: string }>();
  const View = Object.hasOwn(VIEWS, agency) ? VIEWS[agency] : null;
  if (!View) {
    return (
      <div className="p-3">
        <ErrorBox text={`There is no portal called "${agency}".`} />
        <Link href="/portals" className="inline-block mt-2 text-[12px] text-accent hover:underline">All portals</Link>
      </div>
    );
  }
  return <View />;
}

export default function AgencyPage() {
  return (
    <Suspense fallback={<div className="p-3"><Loading text="Loading the portal" /></div>}>
      <AgencyView />
    </Suspense>
  );
}
