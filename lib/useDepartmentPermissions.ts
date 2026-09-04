import { useEffect, useState } from 'react';
import { getCurrentAppUser } from '@/lib/supabaseClient';
import { getMyDepartments, MyDepartment } from '@/lib/departments';

export type DepartmentPermissions = {
  userId: string | null;
  isSystemAdmin: boolean;
  myDepartments: MyDepartment[];
  loading: boolean;
};

/** 各受管資料表的畫面共用：讀取「我是誰、身兼哪些部門、是不是系統管理員S」，決定畫面上按鈕行為要「直接寫」還是「送審」。
 *  管理員帳號用「身分切換」切到教師視角時（sessionStorage.viewMode==='teacher'），這裡直接把
 *  isSystemAdmin/myDepartments 當作沒有管理權限——這樣所有靠這個 hook 判斷「能不能直接寫、
 *  看不看得到管理設定」的畫面（成績相關設定、學校課表、任課教師設定…）才會真的照教師視角的樣子
 *  顯示（用「送審」而不是直接寫、看不到管理專屬的設定分頁），不會因為帳號本身角色其實是管理員
 *  就繼續看得到管理功能。 */
export function useDepartmentPermissions(): DepartmentPermissions {
  const [state, setState] = useState<DepartmentPermissions>({
    userId: null,
    isSystemAdmin: false,
    myDepartments: [],
    loading: true,
  });

  useEffect(() => {
    (async () => {
      const me = await getCurrentAppUser();
      if (!me) {
        setState({ userId: null, isSystemAdmin: false, myDepartments: [], loading: false });
        return;
      }
      const viewingAsTeacher = typeof window !== 'undefined' && sessionStorage.getItem('viewMode') === 'teacher';
      if (viewingAsTeacher) {
        setState({ userId: me.id, isSystemAdmin: false, myDepartments: [], loading: false });
        return;
      }
      const depts = await getMyDepartments(me.id);
      setState({ userId: me.id, isSystemAdmin: me.role === 'system_admin_s', myDepartments: depts, loading: false });
    })();
  }, []);

  return state;
}
