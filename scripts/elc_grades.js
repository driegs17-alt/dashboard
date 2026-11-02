// Run inside a signed-in eLC tab (https://uga.view.usg.edu/...) with the
// browser's JavaScript tool. Reads your own gradebook through eLC's API
// (read-only GETs) and returns compact JSON for scripts/build_grades.py.
// Nothing is written to eLC. Paste the whole file; the last expression
// is the result.
(async () => {
  const OUS = __OUS__; // e.g. {"ECON 2105": 3957191, ...}, filled in from data/courses.json
  const versions = await fetch("/d2l/api/versions/").then((r) => r.json());
  const L = versions.find((v) => v.ProductCode === "le").LatestVersion;
  const get = async (path) => {
    const r = await fetch(path, { credentials: "same-origin" });
    if (!r.ok) return null;
    return r.json();
  };
  const all = async (path) => {
    // PagedResultSet / ObjectListPage helper
    const out = [];
    let url = path;
    for (let i = 0; i < 20 && url; i++) {
      const page = await get(url);
      if (!page) break;
      if (Array.isArray(page)) return page;
      out.push(...(page.Objects || page.Items || []));
      url = page.Next || (page.PagingInfo && page.PagingInfo.HasMoreItems ? `${path}${path.includes("?") ? "&" : "?"}bookmark=${page.PagingInfo.Bookmark}` : null);
    }
    return out;
  };
  const r2 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);
  const overdue = (await get(`/d2l/api/le/${L}/overdueItems/myItems`))?.Objects || [];

  const courses = [];
  for (const [code, ou] of Object.entries(OUS)) {
    const [setup, cats, objs, vals, events, folders, quizzes, finalCalc] = await Promise.all([
      get(`/d2l/api/le/${L}/${ou}/grades/setup/`),
      get(`/d2l/api/le/${L}/${ou}/grades/categories/`),
      get(`/d2l/api/le/${L}/${ou}/grades/`),
      get(`/d2l/api/le/${L}/${ou}/grades/values/myGradeValues/`),
      all(`/d2l/api/le/${L}/${ou}/calendar/events/myEvents/?startDateTime=2026-01-01T00:00:00.000Z&endDateTime=2027-06-01T00:00:00.000Z`),
      get(`/d2l/api/le/${L}/${ou}/dropbox/folders/`),
      all(`/d2l/api/le/${L}/${ou}/quizzes/`),
      get(`/d2l/api/le/${L}/${ou}/grades/final/values/myGradeValue`),
    ]);
    const valBy = Object.fromEntries((vals || []).map((v) => [v.GradeObjectIdentifier, v]));
    const subs = {};
    for (const f of folders || []) {
      const s = await get(`/d2l/api/le/${L}/${ou}/dropbox/folders/${f.Id}/submissions/mysubmissions/`);
      const list = (s || []).flatMap((e) => e.Submissions || []);
      subs[f.Id] = list.length ? list.map((x) => x.SubmissionDate).sort().pop() : null;
    }
    courses.push({
      code,
      ou,
      url: `https://uga.view.usg.edu/d2l/lms/grades/my_grades/main.d2l?ou=${ou}`,
      system: setup?.GradingSystem || null,
      nullIsZero: setup?.IsNullGradeZero ?? null,
      final: finalCalc ? { displayed: finalCalc.DisplayedGrade, num: r2(finalCalc.PointsNumerator), den: r2(finalCalc.PointsDenominator) } : null,
      categories: (cats || []).map((c) => ({
        id: c.Id, name: c.Name.trim(), weight: c.Weight, max: c.MaxPoints, dropLow: c.NumberOfLowestToDrop, dropHigh: c.NumberOfHighestToDrop,
        exclude: c.ExcludeFromFinalGrade, dist: c.WeightDistributionType,
        value: valBy[String(c.Id)] ? { wNum: r2(valBy[String(c.Id)].WeightedNumerator), wDen: r2(valBy[String(c.Id)].WeightedDenominator), shown: valBy[String(c.Id)].DisplayedGrade } : null,
      })),
      items: (objs || []).filter((o) => o.GradeType !== "Category" && o.GradeType !== "Text").map((o) => {
        const v = valBy[String(o.Id)];
        return {
          id: o.Id, name: o.Name.replace(/\s+/g, " ").trim(), catId: o.CategoryId || null, max: o.MaxPoints, weight: r2(o.Weight),
          bonus: o.IsBonus, exclude: o.ExcludeFromFinalGradeCalculation, type: o.GradeType,
          tool: o.AssociatedTool ? o.AssociatedTool.ToolId : null,
          got: v ? r2(v.PointsNumerator) : null, wNum: v ? r2(v.WeightedNumerator) : null, wDen: v ? r2(v.WeightedDenominator) : null,
          shown: v ? v.DisplayedGrade : null, feedback: Boolean(v && v.Comments && v.Comments.Text),
        };
      }),
      events: (events || []).map((e) => ({ title: e.Title.replace(/\s+/g, " ").trim(), due: e.EndDateTime || e.StartDateTime, url: e.CalendarEventViewUrl || "" })),
      dropbox: (folders || []).map((f) => ({ name: f.Name.replace(/\s+/g, " ").trim(), gradeItemId: f.GradeItemId, due: f.DueDate, submittedAt: subs[f.Id] })),
      quizzes: (quizzes || []).map((q) => ({ name: q.Name.replace(/\s+/g, " ").trim(), gradeItemId: q.GradeItemId, due: q.DueDate || q.EndDate })),
      overdue: overdue.filter((o) => o.OrgUnitId === ou).map((o) => ({ name: o.ItemName.replace(/\s+/g, " ").trim(), due: o.DueDate })),
    });
  }
  return { scraped: new Date().toISOString(), courses };
})();
