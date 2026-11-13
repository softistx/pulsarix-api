import type { AccountLimits } from "../accounts";
import type { OrganisationLimits } from "../organisations";
import type { IpLimits } from "./ip.limits";

// All the limits the kernel reads: organisation creation, the anonymous
// mutations per address and the verification mails per account.
export type KernelLimits = OrganisationLimits &
  Partial<IpLimits> &
  Partial<AccountLimits>;
