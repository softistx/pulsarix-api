import type { OrganisationLimits } from "../organisations/organisations.limits";
import type { IpLimits } from "./ip.limits";

// All the limits the kernel reads: organisation creation and the anonymous
// mutations per address.
export type KernelLimits = OrganisationLimits & Partial<IpLimits>;
