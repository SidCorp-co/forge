// cm:why one definition: the revision spec and criterion shapes live in @forge/contracts, which a
// suggestion's revision payload, the REST body and the web all read (ISS-58)
export {
  requirementCriterionSchema as criterionSchema,
  requirementSpecSchema as specSchema,
} from '@forge/contracts/suggestions';
