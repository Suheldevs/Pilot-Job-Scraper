-- Profile 1's must_have/nice_to_have were seeded from scoring.CANDIDATE_SKILLS,
-- but the relevance gate builds ROLE_TERMS from must_have + nice_to_have. Those
-- are different lists: CANDIDATE_SKILLS holds named technologies for scoring,
-- while ROLE_TERMS also needs the role words ("full stack", "backend",
-- "software engineer", "sde"). Seeded from the wrong one, loading the profile
-- shrank the gate from 29 terms to 12 and silently rejected every
-- "Full Stack Developer" title as "no role/stack match".
--
-- Re-seed from relevance.ROLE_TERMS' own split, which is what profile.DEFAULTS
-- mirrors, so behaviour is identical whether a profile is loaded or not.
UPDATE profiles SET
  must_have    = '["full stack", "fullstack", "full-stack", "mern", "mean", "react", "reactjs", "react native", "next", "nextjs", "next.js", "node", "nodejs", "node.js", "express", "mongodb", "mongo", "javascript", "typescript"]',
  nice_to_have = '["frontend", "front end", "front-end", "backend", "back end", "back-end", "web developer", "software engineer", "software developer", "sde"]'
WHERE id = 1;
