import { Transaction } from "@matter/general";

// matter.js locks the datasource behind a behavior, but the reactor's lock check
// reads lockedBy off the raw object, so hand it the datasource itself.
export function lockResource(behavior: object): Transaction.Resource {
  let resource = behavior as Transaction.Resource;
  while (resource[Transaction.Resource.reference]) {
    resource = resource[Transaction.Resource.reference] as Transaction.Resource;
  }
  return resource;
}
