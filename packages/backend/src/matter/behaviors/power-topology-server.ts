import { PowerTopologyServer as Base } from "@matter/main/behaviors";
import { PowerTopology } from "@matter/main/clusters";

// A bridge shares one node, so node scope would attribute one endpoint's power
// to every accessory (#431). Tree scope keeps it on the endpoint and its
// children. NODE/TREE/SET are a choice, so this replaces the feature.
export const HaPowerTopologyServer = Base.with(
  PowerTopology.Feature.TreeTopology,
);
